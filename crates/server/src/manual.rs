//! Controlled one-write acceptance; shares the production HTTP/signing implementation.
use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use chrono_tz::Asia::Shanghai;
use hdu_sniper_core::json::{value_to_i64, value_to_string};
use hdu_sniper_hdu::{HduError, HttpTimings, LibraryClient};
use hdu_sniper_store::Store;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Instant;
mod cli;
mod live;
pub use cli::run;
#[cfg(test)]
mod tests;

type Result<T> = anyhow::Result<T>;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub date: NaiveDate,
    pub start_hour: u32,
    pub hours: i64,
    pub seat: String,
}
impl Selection {
    fn begin(&self) -> Result<DateTime<Utc>> {
        anyhow::ensure!(
            ["162", "157"].contains(&self.seat.as_str()),
            "INVALID_SELECTION: 仅允许162或157"
        );
        anyhow::ensure!(
            (1..=15).contains(&self.hours)
                && self.start_hour < 24
                && i64::from(self.start_hour) + self.hours <= 24,
            "INVALID_SELECTION: 时间/时长无效"
        );
        Ok(Shanghai
            .from_local_datetime(&self.date.and_hms_opt(self.start_hour, 0, 0).unwrap())
            .single()
            .unwrap()
            .with_timezone(&Utc))
    }
    fn confirmation(&self) -> String {
        format!(
            "{} {:02}:00-{:02}:00 宋韵云图四楼{}",
            self.date,
            self.start_hour,
            i64::from(self.start_hour) + self.hours,
            self.seat
        )
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Timings {
    pub login_check_ms: f64,
    pub catalog_read_ms: f64,
    pub id_resolution_ms: f64,
    pub conflict_read_ms: f64,
    pub pre_submit_local_ms: f64,
    pub verification_ms: f64,
    pub http: Option<HttpTimings>,
}
fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Seat {
    number: String,
    id: String,
    free: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preview {
    ticket: String,
    selection: Selection,
    room: String,
    seats: Vec<Seat>,
    range: Value,
    conflicts: usize,
    timings: Timings,
}

trait Gateway {
    fn now(&self) -> DateTime<Utc>;
    fn uid(&self) -> String;
    async fn identity(&self) -> std::result::Result<bool, HduError>;
    async fn catalog(&self, selection: Option<&Selection>) -> Result<(Value, Vec<Value>)>;
    async fn records(&self) -> std::result::Result<Vec<Value>, HduError>;
    async fn submit(
        &self,
        seat: &str,
        begin: DateTime<Utc>,
        hours: i64,
    ) -> (std::result::Result<Value, HduError>, HttpTimings);
}

/// Only explicit absolute ISO dates are interpreted. Numeric offsets and other
/// undocumented shapes are reported as UNSUPPORTED_DATE_CONTRACT, never guessed.
fn date_bounds(range: &Value) -> Result<(NaiveDate, NaiveDate)> {
    let parse = |key: &str| {
        range[key]
            .as_str()
            .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
    };
    let first = parse("advance_date")
        .ok_or_else(|| anyhow::anyhow!("UNSUPPORTED_DATE_CONTRACT: advance_date需只读核实"))?;
    let last = parse("max_date")
        .ok_or_else(|| anyhow::anyhow!("UNSUPPORTED_DATE_CONTRACT: max_date需只读核实"))?;
    anyhow::ensure!(
        first <= last && (last - first).num_days() <= 31,
        "UNSUPPORTED_DATE_CONTRACT: 日期边界异常"
    );
    Ok((first, last))
}
fn validate_range(range: &Value, s: &Selection, now: DateTime<Utc>) -> Result<()> {
    let begin = s.begin()?;
    anyhow::ensure!(begin > now, "NOT_OPEN: 开始时间必须在未来");
    let (first, last) = date_bounds(range)?;
    anyhow::ensure!(
        s.date >= first && s.date <= last,
        "NOT_OPEN: 所选日期未开放"
    );
    let n = |key: &str| {
        range
            .get(key)
            .and_then(|v| {
                v.as_i64()
                    .or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok()))
            })
            .filter(|v| *v >= 0 && *v <= 24)
            .ok_or_else(|| anyhow::anyhow!("INVALID_RANGE: 缺少时段字段"))
    };
    anyhow::ensure!(
        i64::from(s.start_hour) >= n("minBeginTime")?
            && i64::from(s.start_hour) + s.hours <= n("maxEndTime")?
            && s.hours >= n("min_duration")?
            && s.hours <= n("max_duration")?,
        "INVALID_RANGE: 馆方不允许所选时段"
    );
    Ok(())
}
fn safe_range(range: &Value) -> Value {
    let mut output = serde_json::Map::new();
    for key in [
        "advance_date",
        "max_date",
        "minBeginTime",
        "maxEndTime",
        "min_duration",
        "max_duration",
        "max_num",
    ] {
        let v = &range[key];
        // Never print arbitrary upstream objects containing identity/cookie data.
        let value = if v.is_number() || v.is_null() {
            v.clone()
        } else if let Some(s) = v.as_str() {
            if s.len() <= 32
                && s.chars()
                    .all(|c| c.is_ascii_digit() || "-/: .T+Z".contains(c))
            {
                v.clone()
            } else {
                json!("unsupported")
            }
        } else {
            json!("unsupported")
        };
        output.insert(key.into(), value);
    }
    Value::Object(output)
}
fn resolve(floors: &[Value]) -> Result<(String, Vec<Seat>)> {
    let matches: Vec<_> = floors
        .iter()
        .filter(|f| {
            f["roomName"]
                .as_str()
                .is_some_and(crate::strict::target_room)
        })
        .collect();
    anyhow::ensure!(matches.len() == 1, "MAPPING_INVALID: 区域不唯一或缺失");
    let f = matches[0];
    anyhow::ensure!(
        value_to_i64(&f["seatMap"]["info"]["id"]) > 0,
        "MAPPING_INVALID: 楼层ID无效"
    );
    let pois = f["seatMap"]["POIs"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("MAPPING_INVALID: 无座位图"))?;
    let mut seats = vec![];
    for number in ["162", "157"] {
        let entries: Vec<_> = pois
            .iter()
            .filter(|p| {
                p.get("title")
                    .map(value_to_string)
                    .is_some_and(|t| t.trim() == number)
            })
            .collect();
        anyhow::ensure!(entries.len() == 1, "MAPPING_INVALID: 编号缺失或重复");
        let id = entries[0]
            .get("id")
            .map(value_to_string)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow::anyhow!("MAPPING_INVALID: 内部ID缺失"))?;
        let state = entries[0]
            .get("state")
            .map(value_to_string)
            .unwrap_or_default();
        anyhow::ensure!(
            ["0", "1", "3"].contains(&state.as_str()),
            "MAPPING_INVALID: 未知座位状态"
        );
        seats.push(Seat {
            number: number.into(),
            id,
            free: state == "0",
        });
    }
    anyhow::ensure!(seats[0].id != seats[1].id, "MAPPING_INVALID: 内部ID重复");
    Ok((value_to_string(&f["roomName"]), seats))
}
fn overlaps(records: &[Value], s: &Selection) -> Result<Vec<Value>> {
    let begin = s.begin()?.timestamp();
    let end = begin + s.hours * 3600;
    let mut found = vec![];
    for r in records {
        let status = r.get("status").map(value_to_string).unwrap_or_default();
        if ["3", "4", "5", "6", "7", "9"].contains(&status.as_str()) {
            continue;
        }
        anyhow::ensure!(
            ["0", "1", "2"].contains(&status.as_str()),
            "RECORDS_UNKNOWN: 预约状态无法确认"
        );
        let a = r.get("time").map(value_to_i64).unwrap_or(0);
        let duration = r.get("duration").map(value_to_i64).unwrap_or(0);
        anyhow::ensure!(
            a > 0 && (1..=86400).contains(&duration),
            "RECORDS_UNKNOWN: 时段无法确认"
        );
        let record_end = a
            .checked_add(duration)
            .ok_or_else(|| anyhow::anyhow!("RECORDS_UNKNOWN: 时段超出范围"))?;
        if a < end && record_end > begin {
            found.push(r.clone());
        }
    }
    Ok(found)
}
fn category(error: &HduError) -> &'static str {
    match error {
        HduError::Http(404) => "HTTP_404",
        HduError::Http(429 | 403) => "LIMITED",
        HduError::AuthenticationExpired(_) | HduError::Http(401) => "AUTH_REQUIRED",
        HduError::RequestTimeout => "TIMEOUT",
        HduError::Network(_) => "NETWORK_ERROR",
        _ => "UPSTREAM_ERROR",
    }
}
async fn prepare<G: Gateway>(g: &G, selection: Selection) -> Result<Preview> {
    let mut timings = Timings::default();
    let t = Instant::now();
    let expected = g.uid();
    anyhow::ensure!(
        !expected.is_empty()
            && g.identity()
                .await
                .map_err(|e| anyhow::anyhow!("LOGIN_{}", category(&e)))?
            && g.uid() == expected,
        "AUTH_REQUIRED: 登录失效或身份改变"
    );
    timings.login_check_ms = ms(t);
    let t = Instant::now();
    let (range, floors) = g.catalog(Some(&selection)).await?;
    timings.catalog_read_ms = ms(t);
    validate_range(&range, &selection, g.now())?;
    let t = Instant::now();
    let (room, seats) = resolve(&floors)?;
    timings.id_resolution_ms = ms(t);
    anyhow::ensure!(
        seats.iter().any(|s| s.number == selection.seat && s.free),
        "SEAT_UNAVAILABLE: 所选座位已占用，禁止提交"
    );
    let t = Instant::now();
    let records = g
        .records()
        .await
        .map_err(|e| anyhow::anyhow!("RECORDS_{}", category(&e)))?;
    timings.conflict_read_ms = ms(t);
    let conflicts = overlaps(&records, &selection)?.len();
    anyhow::ensure!(conflicts == 0, "EXISTING: 已有冲突预约");
    Ok(Preview {
        ticket: uuid::Uuid::new_v4().to_string(),
        selection,
        room,
        seats,
        range: safe_range(&range),
        conflicts,
        timings,
    })
}
async fn inspect<G: Gateway>(g: &G) -> Result<Value> {
    let t = Instant::now();
    let expected = g.uid();
    anyhow::ensure!(
        !expected.is_empty()
            && g.identity()
                .await
                .map_err(|e| anyhow::anyhow!("LOGIN_{}", category(&e)))?
            && g.uid() == expected,
        "AUTH_REQUIRED: 没有有效的已授权会话"
    );
    let login_ms = ms(t);
    let t = Instant::now();
    let (range, _) = g.catalog(None).await?;
    let range_ms = ms(t);
    let bounds = date_bounds(&range);
    let dates = bounds.as_ref().ok().map(|(a, b)| {
        (0..=(*b - *a).num_days())
            .map(|d| (*a + Duration::days(d)).to_string())
            .collect::<Vec<_>>()
    });
    let t = Instant::now();
    let records = g
        .records()
        .await
        .map_err(|e| anyhow::anyhow!("RECORDS_{}", category(&e)))?;
    Ok(
        json!({"mode":"READ_ONLY","sessionValid":true,"uidVerified":true,"range":safe_range(&range),"openDates":dates,"dateContractSupported":bounds.is_ok(),"existingRecordCount":records.len(),"seatMapping":"需选择已开放日期和时段后prepare，只对该时段检查座位状态","timings":{"loginCheckMs":login_ms,"catalogReadMs":range_ms,"recordsReadMs":ms(t)}}),
    )
}
async fn submit<G: Gateway>(
    store: &Store,
    g: &G,
    ticket: &str,
    confirmation: &str,
    rules_allowed: bool,
    gate: bool,
) -> Result<Value> {
    if let Some(result) = store.manual_result(&g.uid())? {
        return Ok(serde_json::from_str(&result)?);
    }
    anyhow::ensure!(
        gate && rules_allowed,
        "WRITE_GATE_CLOSED: 需要专用门禁和馆方允许确认"
    );
    let (document, expires) = store
        .manual_load(ticket, &g.uid())?
        .ok_or_else(|| anyhow::anyhow!("INVALID_TICKET"))?;
    anyhow::ensure!(
        g.now().timestamp() <= expires,
        "EXPIRED_PREVIEW: 请重新只读prepare"
    );
    let preview: Preview = serde_json::from_str(&document)?;
    anyhow::ensure!(
        confirmation == preview.selection.confirmation(),
        "CONFIRMATION_REQUIRED: 必须确认完整座位日期时段"
    );
    let uid = g.uid();
    let mut fresh = prepare(g, preview.selection.clone()).await?;
    anyhow::ensure!(uid == g.uid(), "AUTH_REQUIRED: 身份改变");
    let selected = |p: &Preview| {
        p.seats
            .iter()
            .find(|s| s.number == p.selection.seat)
            .map(|s| s.id.clone())
    };
    anyhow::ensure!(
        selected(&fresh) == selected(&preview) && fresh.room == preview.room,
        "MAPPING_CHANGED: 请重新只读prepare"
    );
    let local = Instant::now();
    let begin = fresh.selection.begin()?;
    anyhow::ensure!(
        begin > g.now() && g.now().timestamp() <= expires,
        "EXPIRED_PREVIEW"
    );
    let pending = json!({"mode":"MANUAL_TEST","ticket":ticket,"selection":fresh.selection,"state":"UNKNOWN","reason":"WRITE_INTENT_PERSISTED","attempts":1,"message":"已持久化单次提交意图；中断或重启后禁止重发"});
    if !store.manual_claim(&uid, ticket, &pending.to_string())? {
        return Ok(store
            .manual_result(&uid)?
            .map(|s| serde_json::from_str(&s))
            .transpose()?
            .unwrap_or(json!({"state":"STOPPED","reason":"EXPIRED_PREVIEW"})));
    }
    fresh.timings.pre_submit_local_ms = ms(local);
    let (response, http) = g
        .submit(&selected(&fresh).unwrap(), begin, fresh.selection.hours)
        .await;
    fresh.timings.http = Some(http);
    let message = response
        .as_ref()
        .ok()
        .map(crate::booking::response_message)
        .unwrap_or_default();
    let error = response.as_ref().err().map(category);
    let reason = if message.contains("频繁") || message.contains("封禁") {
        "LIMITED"
    } else if let Some(e) = error {
        e
    } else if response
        .as_ref()
        .ok()
        .is_some_and(|r| r["CODE"] == "NotFound")
    {
        "HTTP_404"
    } else if response
        .as_ref()
        .ok()
        .is_some_and(|r| r["CODE"] == "ok" && r["DATA"]["result"] == "success")
    {
        "SERVER_SUCCESS"
    } else if message.contains("未到") || message.contains("时间范围") {
        "NOT_OPEN"
    } else if crate::booking::is_duplicate_message(&message) {
        "EXISTING"
    } else if crate::booking::is_seat_unavailable_message(&message) {
        "SEAT_UNAVAILABLE"
    } else {
        "RESPONSE_REQUIRES_VERIFICATION"
    };
    let verify_start = Instant::now();
    let records = g.records().await;
    fresh.timings.verification_ms = ms(verify_start);
    let verification_invalid = records
        .as_ref()
        .ok()
        .is_some_and(|r| overlaps(r, &fresh.selection).is_err());
    let matched = records
        .as_ref()
        .ok()
        .and_then(|r| overlaps(r, &fresh.selection).ok())
        .is_some_and(|r| {
            r.iter().any(|r| {
                r.get("time").map(value_to_i64) == Some(begin.timestamp())
                    && r.get("duration").map(value_to_i64) == Some(fresh.selection.hours * 3600)
                    && r.get("seatNum").map(value_to_string).as_deref()
                        == Some(fresh.selection.seat.as_str())
                    && r.get("roomName").map(value_to_string).as_deref()
                        == Some(fresh.room.as_str())
            })
        });
    let state = if matched {
        "SUCCESS"
    } else if [
        "LIMITED",
        "AUTH_REQUIRED",
        "NOT_OPEN",
        "SEAT_UNAVAILABLE",
        "EXISTING",
    ]
    .contains(&reason)
    {
        "STOPPED"
    } else {
        "UNKNOWN"
    };
    let result = json!({"mode":"MANUAL_TEST","ticket":ticket,"selection":fresh.selection,"state":state,"reason":reason,"recordVerified":matched,"attempts":1,"verificationError":records.as_ref().err().map(category).or(if verification_invalid {Some("RECORDS_UNKNOWN")} else {None}),"timings":fresh.timings,"timingScope":"客户端单调时钟观测；发送调用至响应头包含网络/排队/服务器，无法分离纯服务端耗时；不代表20:00高峰"});
    store.manual_finish(&uid, ticket, &result.to_string())?;
    Ok(result)
}
