//! Fixed cloud policy. No prelock, write retries, or user-configurable seats.
use chrono::{DateTime, Duration, TimeZone, Utc};
use chrono_tz::Asia::Shanghai;
use hdu_sniper_core::json::{value_to_i64, value_to_string};
use hdu_sniper_hdu::{HduError, LibraryClient};
use hdu_sniper_store::{Store, StoreError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

mod api;
mod live;
pub use api::*;
#[cfg(test)]
mod tests;

type Result<T> = std::result::Result<T, StoreError>;
const MANUAL: &str = "自动抢座已停止，请手动选择其他座位。";
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Mapping {
    room_query: String,
    floor_id: i64,
    room_name: String,
    ids: [String; 2],
    verified_at: i64,
    checksum: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Task {
    key: String,
    uid: String,
    date: String,
    begin: i64,
    opens: i64,
    state: String,
    message: String,
    attempts: Vec<String>,
    mapping: Option<Mapping>,
    updated_at: i64,
}
impl Task {
    fn new(uid: &str, now: DateTime<Utc>) -> Self {
        let today = now.with_timezone(&Shanghai).date_naive();
        let date = today + Duration::days(2);
        let begin = Shanghai
            .from_local_datetime(&date.and_hms_opt(8, 0, 0).unwrap())
            .single()
            .unwrap()
            .timestamp();
        let opens = Shanghai
            .from_local_datetime(&today.and_hms_opt(20, 0, 0).unwrap())
            .single()
            .unwrap()
            .timestamp();
        Self {
            key: format!("{uid}:{date}:08:22"),
            uid: uid.into(),
            date: date.to_string(),
            begin,
            opens,
            state: "WAITING".into(),
            message: "等待北京时间 20:00".into(),
            attempts: vec![],
            mapping: None,
            updated_at: now.timestamp(),
        }
    }
    fn create(store: &Store, uid: &str, now: DateTime<Utc>) -> Result<Self> {
        let t = Self::new(uid, now);
        store.strict_create(&t.key, &serde_json::to_string(&t)?)?;
        Ok(serde_json::from_str(&store.strict_get(&t.key)?.unwrap())?)
    }
    fn transition(&mut self, store: &Store, state: &str, message: &str) -> Result<bool> {
        let before = serde_json::to_string(self)?;
        let mut next = self.clone();
        next.state = state.into();
        next.message = message.into();
        next.updated_at = Utc::now().timestamp();
        if store.strict_cas(&self.key, &before, &serde_json::to_string(&next)?)? {
            *self = next;
            Ok(true)
        } else {
            Ok(false)
        }
    }
}

// Testable clock and I/O boundary; live adapter reuses the current Rust client.
trait Gateway: Send + Sync {
    fn now(&self) -> DateTime<Utc>;
    async fn identity(&self, uid: &str) -> bool;
    async fn prepare(&self) -> std::result::Result<Mapping, HduError>;
    async fn records(&self) -> std::result::Result<Vec<Value>, HduError>;
    async fn submit(&self, id: &str, begin: i64) -> std::result::Result<Value, HduError>;
    async fn pace(&self);
}

// Unknown/malformed active records block writes. Cancelled/completed records are ignored
// using the same status contract as bookings_api.rs.
fn conflicts(records: &[Value], task: &Task) -> std::result::Result<Vec<Value>, ()> {
    let mut found = vec![];
    for r in records {
        let status = r.get("status").map(value_to_string).ok_or(())?;
        if ["3", "4", "5", "6", "7", "9"].contains(&status.as_str()) {
            continue;
        }
        if !["0", "1", "2"].contains(&status.as_str()) {
            return Err(());
        }
        let start = r
            .get("time")
            .map(value_to_i64)
            .filter(|n| *n > 0)
            .ok_or(())?;
        let duration = r
            .get("duration")
            .map(value_to_i64)
            .filter(|n| *n > 0 && *n <= 86400)
            .ok_or(())?;
        if start < task.begin + 14 * 3600 && start + duration > task.begin {
            found.push(r.clone());
        }
    }
    Ok(found)
}
fn verified(records: &[Value], task: &Task, seat: &str) -> bool {
    records.iter().any(|r| {
        r["time"]
            .as_i64()
            .or_else(|| r["time"].as_str()?.parse().ok())
            == Some(task.begin)
            && r.get("duration").map(value_to_i64) == Some(14 * 3600)
            && r.get("seatNum").map(value_to_string).as_deref() == Some(seat)
            && task.mapping.as_ref().is_some_and(|m| {
                r.get("roomName").map(value_to_string).as_deref() == Some(m.room_name.as_str())
            })
    })
}
async fn check_records<G: Gateway>(store: &Store, task: &mut Task, gateway: &G) -> Result<bool> {
    match gateway
        .records()
        .await
        .ok()
        .and_then(|r| conflicts(&r, task).ok())
    {
        Some(r) if r.is_empty() => Ok(true),
        Some(_) => {
            task.transition(store, "EXISTING", "目标时段已有预约，已停止")?;
            Ok(false)
        }
        None => {
            task.transition(store, "UNKNOWN", "预约记录无法确认，已停止写入")?;
            Ok(false)
        }
    }
}
async fn tick<G: Gateway>(
    store: &Store,
    task: &mut Task,
    g: &G,
    writes_allowed: bool,
) -> Result<()> {
    let now = g.now().timestamp();
    // Never roll a persisted task forward to a new date after a restart.
    if now >= task.opens + 4 * 3600 {
        if ["WAITING", "CHECKED", "READY"].contains(&task.state.as_str()) {
            task.transition(store, "STOPPED", "当天执行窗口已结束")?;
        }
        return Ok(());
    }
    if task.state == "WAITING" && now >= task.opens - 300 {
        if !task.transition(
            store,
            "CHECKING",
            "正在检查身份、时钟和已有预约；中断后不自动重试",
        )? {
            return Ok(());
        }
        if !g.identity(&task.uid).await {
            task.transition(
                store,
                "AUTH_REQUIRED",
                "登录或时钟检查失败，请重新认证并检查服务器 NTP",
            )?;
            return Ok(());
        }
        if !check_records(store, task, g).await? {
            return Ok(());
        }
        if !task.transition(store, "CHECKED", "身份、时钟、预约记录检查完成")? {
            return Ok(());
        }
    }
    if task.state == "CHECKED" && now >= task.opens - 120 {
        if !task.transition(store, "PREPARING", "正在验证房间和座位编号；只读准备")?
        {
            return Ok(());
        }
        match g.prepare().await {
            Ok(mapping) if valid_mapping(&mapping, g.now().timestamp()) => {
                let before = serde_json::to_string(task)?;
                task.mapping = Some(mapping);
                task.state = "READY".into();
                task.message = "准备就绪，等待开放；缓存不代表未来可用".into();
                if !store.strict_cas(&task.key, &before, &serde_json::to_string(task)?)? {
                    return Ok(());
                }
            }
            _ => {
                task.transition(store, "STOPPED", "座位映射或服务可达性验证失败，禁止提交")?;
                return Ok(());
            }
        }
    }
    if task.state != "READY" || g.now().timestamp() < task.opens {
        return Ok(());
    }
    if !writes_allowed {
        task.transition(store, "STOPPED", "真实写入未授权；离线验收模式已停止")?;
        return Ok(());
    }
    if !task.transition(store, "RUNNING", "检查开放窗口及已有预约；中断后不自动重试")?
    {
        return Ok(());
    }
    for (index, seat) in ["162", "157"].iter().enumerate() {
        if index > 0 {
            g.pace().await;
        }
        if g.now().timestamp() < task.opens || g.now().timestamp() >= task.opens + 4 * 3600 {
            task.transition(store, "STOPPED", "不在合法开放窗口")?;
            return Ok(());
        }
        if !g.identity(&task.uid).await {
            task.transition(
                store,
                "AUTH_REQUIRED",
                "登录或时钟检查失败，请重新认证并检查 NTP",
            )?;
            return Ok(());
        }
        if !check_records(store, task, g).await? {
            return Ok(());
        }
        let Some(mapping) = task
            .mapping
            .as_ref()
            .filter(|m| valid_mapping(m, g.now().timestamp()))
        else {
            task.transition(store, "STOPPED", "座位映射已过期或无效，禁止提交")?;
            return Ok(());
        };
        let id = mapping.ids[index].clone();
        if g.now().timestamp() < task.opens || g.now().timestamp() >= task.opens + 4 * 3600 {
            task.transition(store, "STOPPED", "开放窗口已变化，停止提交")?;
            return Ok(());
        }
        let before = serde_json::to_string(task)?;
        task.attempts.push(seat.to_string());
        task.updated_at = g.now().timestamp();
        task.state = format!("SUBMITTING_{seat}");
        task.message = format!("正在预约 {seat}；若进程中断则结果待确认，禁止重发");
        // Atomic durable write-ahead intent and cancellation fence. No lease expiry/retry.
        if !store.strict_cas(&task.key, &before, &serde_json::to_string(task)?)? {
            return Ok(());
        }
        let response = g.submit(&id, task.begin).await;
        let message = response
            .as_ref()
            .ok()
            .map(crate::booking::response_message)
            .unwrap_or_default();
        let limited = matches!(&response, Err(HduError::Http(429 | 403)))
            || message.contains("频繁")
            || message.contains("封禁");
        let auth_lost = matches!(
            &response,
            Err(HduError::AuthenticationExpired(_)) | Err(HduError::Http(401))
        );
        if limited || auth_lost {
            task.transition(
                store,
                if limited { "LIMITED" } else { "AUTH_REQUIRED" },
                if limited {
                    "触发限流或账号限制，立即停止"
                } else {
                    "登录失效，请重新认证"
                },
            )?;
            return Ok(());
        }
        // Read reconciliation even after a timeout/404. Empty records do NOT prove failed write.
        let reconciled = g
            .records()
            .await
            .ok()
            .and_then(|r| conflicts(&r, task).ok());
        if let Some(records) = &reconciled {
            if verified(records, task, seat) {
                task.transition(
                    store,
                    "SUCCESS",
                    &format!("预约 {seat} 成功，已核对预约记录"),
                )?;
                return Ok(());
            }
            if !records.is_empty() {
                task.transition(store, "EXISTING", "发现目标时段预约，停止自动任务")?;
                return Ok(());
            }
        }
        let unavailable = response.as_ref().is_ok_and(|r| r["CODE"] == "ParamError")
            && crate::booking::is_seat_unavailable_message(&message)
            && !message.contains("未到")
            && !message.contains("时间范围");
        if unavailable && reconciled.is_some() {
            if index == 1 {
                task.transition(store, "FAILED", MANUAL)?;
                return Ok(());
            }
            if !task.transition(store, "RUNNING", "162 明确不可用；等待至少 10 秒后检查 157")?
            {
                return Ok(());
            }
        } else {
            task.transition(
                store,
                "UNKNOWN",
                "提交结果待确认，已停止写入；请核对官方预约记录",
            )?;
            return Ok(());
        }
    }
    Ok(())
}
fn mapping_checksum(m: &Mapping) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (
        &m.room_query,
        m.floor_id,
        &m.room_name,
        &m.ids,
        m.verified_at,
    )
        .hash(&mut h);
    h.finish()
}
fn valid_mapping(m: &Mapping, now: i64) -> bool {
    m.checksum == mapping_checksum(m)
        && m.floor_id > 0
        && !m.room_query.is_empty()
        && target_room(&m.room_name)
        && m.ids.iter().all(|s| !s.trim().is_empty())
        && m.ids[0] != m.ids[1]
        && (0..=600).contains(&(now - m.verified_at))
}
fn target_room(name: &str) -> bool {
    // Exact aliases only; never infer the floor from a seat number or internal floor ID.
    [
        "宋韵云图（四楼）",
        "宋韵云图(四楼)",
        "四楼宋韵云图",
        "宋韵云图",
    ]
    .contains(&name.trim())
}
