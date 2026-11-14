use super::*;
use std::collections::VecDeque;
use std::sync::Mutex;
fn at(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
}
fn mapping(now: i64) -> Mapping {
    let mut m = Mapping {
        room_query: "q".into(),
        floor_id: 9,
        room_name: "宋韵云图（四楼）".into(),
        ids: ["internal-a".into(), "internal-b".into()],
        verified_at: now,
        checksum: 0,
    };
    m.checksum = mapping_checksum(&m);
    m
}
fn occupied() -> std::result::Result<Value, HduError> {
    Ok(
        json!({"CODE":"ParamError","DATA":{"msg":"选择的座位无法预约，可能座位不可用或已经被其他人锁定或占用"}}),
    )
}
fn success() -> std::result::Result<Value, HduError> {
    Ok(json!({"CODE":"ok","DATA":{"result":"success"}}))
}
struct Fake {
    time: Mutex<DateTime<Utc>>,
    identity: bool,
    replies: Mutex<VecDeque<std::result::Result<Value, HduError>>>,
    calls: Mutex<Vec<String>>,
    records: Mutex<VecDeque<std::result::Result<Vec<Value>, HduError>>>,
    stop_on_pace: Option<Arc<Store>>,
}
impl Fake {
    fn new(replies: Vec<std::result::Result<Value, HduError>>) -> Self {
        Self {
            time: Mutex::new(at("2026-11-14T20:00:00+08:00")),
            identity: true,
            replies: Mutex::new(replies.into()),
            calls: Mutex::new(vec![]),
            records: Mutex::new(VecDeque::new()),
            stop_on_pace: None,
        }
    }
    fn snapshots(&self, snapshots: Vec<Vec<Value>>) {
        *self.records.lock().unwrap() = snapshots.into_iter().map(Ok).collect();
    }
}
impl Gateway for Fake {
    fn now(&self) -> DateTime<Utc> {
        *self.time.lock().unwrap()
    }
    async fn identity(&self, _: &str) -> bool {
        self.identity
    }
    async fn prepare(&self) -> std::result::Result<Mapping, HduError> {
        Ok(mapping(self.now().timestamp()))
    }
    async fn records(&self) -> std::result::Result<Vec<Value>, HduError> {
        self.records
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(vec![]))
    }
    async fn submit(&self, id: &str, begin: i64) -> std::result::Result<Value, HduError> {
        assert_eq!(begin, at("2026-11-16T08:00:00+08:00").timestamp());
        self.calls.lock().unwrap().push(id.into());
        self.replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected write")
    }
    async fn pace(&self) {
        *self.time.lock().unwrap() += Duration::seconds(10);
        if let Some(s) = &self.stop_on_pace {
            let mut t: Task = serde_json::from_str(&s.strict_all().unwrap()[0]).unwrap();
            t.transition(s, "STOPPED", "manual").unwrap();
        }
    }
}
fn ready(store: &Store, g: &Fake) -> Task {
    let mut t = Task::new("123", g.now());
    t.state = "READY".into();
    t.mapping = Some(mapping(g.now().timestamp()));
    store
        .strict_create(&t.key, &serde_json::to_string(&t).unwrap())
        .unwrap();
    t
}
fn record(t: &Task, seat: &str) -> Value {
    json!({"id":"booking","time":t.begin,"duration":50400,"status":"0","seatNum":seat,"roomName":"宋韵云图（四楼）"})
}
#[tokio::test]
async fn primary_success_one_write() {
    let s = Store::open_in_memory().unwrap();
    let g = Fake::new(vec![success()]);
    let mut t = ready(&s, &g);
    g.snapshots(vec![vec![], vec![record(&t, "162")]]);
    tick(&s, &mut t, &g, true).await.unwrap();
    assert_eq!(t.state, "SUCCESS");
    assert_eq!(*g.calls.lock().unwrap(), ["internal-a"]);
}
#[tokio::test]
async fn fallback_only_after_explicit_rejection() {
    let s = Store::open_in_memory().unwrap();
    let g = Fake::new(vec![occupied(), success()]);
    let mut t = ready(&s, &g);
    g.snapshots(vec![vec![], vec![], vec![], vec![record(&t, "157")]]);
    tick(&s, &mut t, &g, true).await.unwrap();
    assert_eq!(t.state, "SUCCESS");
    assert_eq!(*g.calls.lock().unwrap(), ["internal-a", "internal-b"]);
    assert_eq!(g.now().timestamp() - t.opens, 10);
}
#[tokio::test]
async fn both_unavailable_never_a_third_seat() {
    let s = Store::open_in_memory().unwrap();
    let g = Fake::new(vec![occupied(), occupied()]);
    let mut t = ready(&s, &g);
    tick(&s, &mut t, &g, true).await.unwrap();
    assert_eq!(t.state, "FAILED");
    assert_eq!(t.message, MANUAL);
    tick(&s, &mut t, &g, true).await.unwrap();
    assert_eq!(g.calls.lock().unwrap().len(), 2);
}
#[tokio::test]
async fn timeout_with_confirmed_record_is_success() {
    let s = Store::open_in_memory().unwrap();
    let g = Fake::new(vec![Err(HduError::RequestTimeout)]);
    let mut t = ready(&s, &g);
    g.snapshots(vec![vec![], vec![record(&t, "162")]]);
    tick(&s, &mut t, &g, true).await.unwrap();
    assert_eq!(t.state, "SUCCESS");
}
#[tokio::test]
async fn timeout_404_and_early_response_are_unknown_without_fallback() {
    for response in [
        Err(HduError::RequestTimeout),
        Err(HduError::Http(404)),
        Ok(json!({"CODE":"ParamError","MESSAGE":"未到预约时间"})),
        success(),
    ] {
        let s = Store::open_in_memory().unwrap();
        let g = Fake::new(vec![response]);
        let mut t = ready(&s, &g);
        tick(&s, &mut t, &g, true).await.unwrap();
        assert_eq!(t.state, "UNKNOWN");
        let mut restarted = Task::create(&s, "123", g.now()).unwrap();
        tick(&s, &mut restarted, &g, true).await.unwrap();
        assert_eq!(g.calls.lock().unwrap().len(), 1);
    }
}
#[tokio::test]
async fn throttle_and_expired_auth_stop_immediately() {
    for (response, state) in [
        (Ok(json!({"CODE":1,"MESSAGE":"请求太频繁了"})), "LIMITED"),
        (Err(HduError::Http(429)), "LIMITED"),
        (
            Err(HduError::AuthenticationExpired("expired".into())),
            "AUTH_REQUIRED",
        ),
    ] {
        let s = Store::open_in_memory().unwrap();
        let g = Fake::new(vec![response]);
        let mut t = ready(&s, &g);
        tick(&s, &mut t, &g, true).await.unwrap();
        assert_eq!(t.state, state);
        assert_eq!(g.calls.lock().unwrap().len(), 1);
    }
}
#[tokio::test]
async fn existing_or_malformed_records_block_all_writes() {
    for malformed in [false, true] {
        let s = Store::open_in_memory().unwrap();
        let g = Fake::new(vec![]);
        let mut t = ready(&s, &g);
        g.snapshots(vec![vec![if malformed {
            json!({"status":"0"})
        } else {
            record(&t, "999")
        }]]);
        tick(&s, &mut t, &g, true).await.unwrap();
        assert!(g.calls.lock().unwrap().is_empty());
        assert_eq!(t.state, if malformed { "UNKNOWN" } else { "EXISTING" });
    }
}
#[test]
fn dates_keep_fixed_hours_across_year_and_month_boundaries() {
    for (now, date) in [
        ("2026-12-31T20:00:00+08:00", "2027-01-02"),
        ("2026-11-30T12:00:00Z", "2026-12-02"),
    ] {
        let t = Task::new("123", at(now));
        assert_eq!(t.date, date);
        assert_eq!(
            DateTime::from_timestamp(t.begin, 0)
                .unwrap()
                .with_timezone(&Shanghai)
                .format("%H:%M")
                .to_string(),
            "08:00"
        );
        assert_eq!(t.begin - t.opens, 36 * 3600);
    }
}
#[tokio::test]
async fn no_preopening_write_preparation_is_read_only() {
    let s = Store::open_in_memory().unwrap();
    let g = Fake::new(vec![]);
    *g.time.lock().unwrap() = at("2026-11-14T19:55:00+08:00");
    let mut t = Task::create(&s, "123", g.now()).unwrap();
    tick(&s, &mut t, &g, true).await.unwrap();
    assert_eq!(t.state, "CHECKED");
    *g.time.lock().unwrap() = at("2026-11-14T19:58:00+08:00");
    tick(&s, &mut t, &g, true).await.unwrap();
    assert_eq!(t.state, "READY");
    assert!(g.calls.lock().unwrap().is_empty());
}
#[tokio::test]
async fn invalid_or_stale_mapping_blocks_write() {
    for stale in [false, true] {
        let s = Store::open_in_memory().unwrap();
        let g = Fake::new(vec![]);
        let mut t = Task::new("123", g.now());
        t.state = "READY".into();
        let mut m = mapping(g.now().timestamp());
        if stale {
            m.verified_at -= 601;
        } else {
            m.ids[0] = "wrong-but-nonempty-id".into();
        }
        t.mapping = Some(m);
        s.strict_create(&t.key, &serde_json::to_string(&t).unwrap())
            .unwrap();
        tick(&s, &mut t, &g, true).await.unwrap();
        assert_eq!(t.state, "STOPPED");
    }
}
#[tokio::test]
async fn auth_preflight_failure_has_zero_writes() {
    let s = Store::open_in_memory().unwrap();
    let mut g = Fake::new(vec![]);
    g.identity = false;
    let mut t = ready(&s, &g);
    tick(&s, &mut t, &g, true).await.unwrap();
    assert_eq!(t.state, "AUTH_REQUIRED");
}
#[tokio::test]
async fn stop_during_fallback_wait_fences_next_write() {
    let s = Arc::new(Store::open_in_memory().unwrap());
    let mut g = Fake::new(vec![occupied()]);
    g.stop_on_pace = Some(s.clone());
    let mut t = ready(&s, &g);
    tick(&s, &mut t, &g, true).await.unwrap();
    assert_eq!(g.calls.lock().unwrap().len(), 1);
    let saved: Task = serde_json::from_str(&s.strict_get(&t.key).unwrap().unwrap()).unwrap();
    assert_eq!(saved.state, "STOPPED");
}
#[tokio::test]
async fn stale_workers_and_duplicate_clicks_cannot_submit_twice() {
    let s = Store::open_in_memory().unwrap();
    let g = Fake::new(vec![occupied(), occupied()]);
    let mut a = ready(&s, &g);
    let mut b = Task::create(&s, "123", g.now()).unwrap();
    assert_eq!(a.key, b.key);
    tick(&s, &mut a, &g, true).await.unwrap();
    tick(&s, &mut b, &g, true).await.unwrap();
    assert_eq!(g.calls.lock().unwrap().len(), 2);
}
#[test]
fn mapping_rejects_ambiguous_room_or_number_and_ignores_today_state() {
    let floor = json!({"roomName":"宋韵云图（四楼）","seatMap":{"info":{"id":9},"POIs":[{"title":"162","id":"a","state":1},{"title":"157","id":"b","state":3}]}});
    assert!(live::resolve_mapping("q", std::slice::from_ref(&floor), 123).is_ok());
    assert!(live::resolve_mapping("q", &[floor.clone(), floor.clone()], 123).is_err());
    let mut bad = floor.clone();
    bad["seatMap"]["POIs"][1]["title"] = json!("162");
    assert!(live::resolve_mapping("q", &[bad], 123).is_err());
    let mut bad = floor;
    bad["roomName"] = json!("其他房间");
    assert!(live::resolve_mapping("q", &[bad], 123).is_err());
}
#[tokio::test]
async fn default_no_write_gate_and_expired_task() {
    let s = Store::open_in_memory().unwrap();
    let g = Fake::new(vec![]);
    let mut t = ready(&s, &g);
    tick(&s, &mut t, &g, false).await.unwrap();
    assert_eq!(t.state, "STOPPED");
    let s = Store::open_in_memory().unwrap();
    let mut t = ready(&s, &g);
    *g.time.lock().unwrap() += Duration::hours(4);
    tick(&s, &mut t, &g, true).await.unwrap();
    assert_eq!(t.state, "STOPPED");
}
#[test]
fn independent_connections_and_restart_preserve_write_intent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.sqlite");
    let s = Store::open(&path).unwrap();
    let other = Store::open(&path).unwrap();
    let now = at("2026-11-14T20:00:00+08:00");
    let mut a = Task::create(&s, "123", now).unwrap();
    let mut b = Task::create(&other, "123", now).unwrap();
    assert!(a.transition(&s, "SUBMITTING_162", "intent").unwrap());
    assert!(!b.transition(&other, "RUNNING", "stale").unwrap());
    drop(s);
    drop(other);
    let reopened = Store::open(path).unwrap();
    assert_eq!(
        Task::create(&reopened, "123", now).unwrap().state,
        "SUBMITTING_162"
    );
}
#[test]
fn stop_atomically_fences_daily_creation() {
    let s = Store::open_in_memory().unwrap();
    let now = at("2026-11-14T19:55:00+08:00");
    let t = Task::new("123", now);
    s.set_meta("strict_daily_uid", "123").unwrap();
    s.strict_create_daily(&t.key, &serde_json::to_string(&t).unwrap(), "123")
        .unwrap();
    s.strict_stop("123").unwrap();
    let tomorrow = Task::new("123", now + Duration::days(1));
    s.strict_create_daily(
        &tomorrow.key,
        &serde_json::to_string(&tomorrow).unwrap(),
        "123",
    )
    .unwrap();
    assert!(s.strict_get(&tomorrow.key).unwrap().is_none());
    assert_eq!(Task::create(&s, "123", now).unwrap().state, "STOPPED");
}
#[tokio::test]
async fn read_404_blocks_writes_and_read_failure_after_reject_blocks_fallback() {
    for after in [false, true] {
        let s = Store::open_in_memory().unwrap();
        let g = Fake::new(vec![occupied()]);
        let mut t = ready(&s, &g);
        {
            let mut records = g.records.lock().unwrap();
            if after {
                records.push_back(Ok(vec![]));
            }
            records.push_back(Err(HduError::Http(404)));
        }
        tick(&s, &mut t, &g, true).await.unwrap();
        assert_eq!(t.state, "UNKNOWN");
        assert_eq!(g.calls.lock().unwrap().len(), usize::from(after));
    }
}
