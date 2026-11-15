use super::*;
use std::cell::{Cell, RefCell};

struct Fake {
    now: DateTime<Utc>,
    selection: Selection,
    authenticated: Cell<bool>,
    range: RefCell<Value>,
    floors: RefCell<Vec<Value>>,
    before: RefCell<Vec<Value>>,
    after: RefCell<Vec<Value>>,
    verify_error: Cell<bool>,
    response: RefCell<Option<std::result::Result<Value, HduError>>>,
    writes: Cell<usize>,
    reads: Cell<usize>,
}
impl Fake {
    fn new() -> Self {
        let now = Utc::now();
        let day = now.with_timezone(&Shanghai).date_naive();
        let s = Selection {
            date: day + Duration::days(1),
            start_hour: 9,
            hours: 1,
            seat: "162".into(),
        };
        let record = json!({"status":0,"time":s.begin().unwrap().timestamp(),"duration":3600,"seatNum":"162","roomName":"宋韵云图（四楼）"});
        Self {
            now,
            selection: s,
            authenticated: Cell::new(true),
            range: RefCell::new(
                json!({"advance_date":day.to_string(),"max_date":(day+Duration::days(2)).to_string(),"minBeginTime":7,"maxEndTime":22,"min_duration":1,"max_duration":15}),
            ),
            floors: RefCell::new(vec![
                json!({"roomName":"宋韵云图（四楼）","seatMap":{"info":{"id":4},"POIs":[{"title":"162","id":"real-162","state":"0"},{"title":"157","id":"real-157","state":"0"}]}}),
            ]),
            before: RefCell::new(vec![]),
            after: RefCell::new(vec![record]),
            verify_error: Cell::new(false),
            response: RefCell::new(Some(Ok(json!({"CODE":"ok","DATA":{"result":"success"}})))),
            writes: Cell::new(0),
            reads: Cell::new(0),
        }
    }
    async fn preview(&self, store: &Store) -> Preview {
        let p = prepare(self, self.selection.clone()).await.unwrap();
        store
            .manual_preview(
                &p.ticket,
                &self.uid(),
                &serde_json::to_string(&p).unwrap(),
                Utc::now().timestamp() + 300,
            )
            .unwrap();
        p
    }
    async fn run(&self, store: &Store, p: &Preview) -> Value {
        submit(
            store,
            self,
            &p.ticket,
            &p.selection.confirmation(),
            true,
            true,
        )
        .await
        .unwrap()
    }
}
impl Gateway for Fake {
    fn now(&self) -> DateTime<Utc> {
        self.now
    }
    fn uid(&self) -> String {
        "123456789".into()
    }
    async fn identity(&self) -> std::result::Result<bool, HduError> {
        self.reads.set(self.reads.get() + 1);
        Ok(self.authenticated.get())
    }
    async fn catalog(&self, _: Option<&Selection>) -> Result<(Value, Vec<Value>)> {
        Ok((self.range.borrow().clone(), self.floors.borrow().clone()))
    }
    async fn records(&self) -> std::result::Result<Vec<Value>, HduError> {
        self.reads.set(self.reads.get() + 1);
        if self.writes.get() > 0 {
            if self.verify_error.get() {
                return Err(HduError::Http(404));
            }
            Ok(self.after.borrow().clone())
        } else {
            Ok(self.before.borrow().clone())
        }
    }
    async fn submit(
        &self,
        seat: &str,
        begin: DateTime<Utc>,
        hours: i64,
    ) -> (std::result::Result<Value, HduError>, HttpTimings) {
        assert_eq!(seat, format!("real-{}", self.selection.seat));
        assert_eq!(begin, self.selection.begin().unwrap());
        assert_eq!(hours, 1);
        self.writes.set(self.writes.get() + 1);
        tokio::task::yield_now().await;
        (
            self.response
                .borrow_mut()
                .take()
                .expect("second write is prohibited"),
            HttpTimings::default(),
        )
    }
}
fn store() -> Store {
    Store::open(":memory:").unwrap()
}

#[tokio::test]
async fn one_success_is_verified_and_repeated_click_is_read_only() {
    let f = Fake::new();
    let db = store();
    let p = f.preview(&db).await;
    let r = f.run(&db, &p).await;
    assert_eq!(r["state"], "SUCCESS");
    assert_eq!(r["recordVerified"], true);
    let reads = f.reads.get();
    let repeated = f.run(&db, &p).await;
    for field in ["state", "selection", "ticket", "attempts", "recordVerified"] {
        assert_eq!(repeated[field], r[field]);
    }
    assert_eq!(f.reads.get(), reads);
    assert_eq!(f.writes.get(), 1);
    assert!(!r.to_string().contains(&f.uid()));
    assert!(r["timings"]["http"]["serverProcessingMs"].is_null());
}
#[tokio::test]
async fn timeout_is_verified_without_reissuing_write() {
    let f = Fake::new();
    let db = store();
    let p = f.preview(&db).await;
    *f.response.borrow_mut() = Some(Err(HduError::RequestTimeout));
    let r = f.run(&db, &p).await;
    assert_eq!(r["state"], "SUCCESS");
    assert_eq!(r["reason"], "TIMEOUT");
    assert_eq!(f.writes.get(), 1);
}
#[tokio::test]
async fn ambiguous_404_timeout_and_invalid_record_stop_without_fallback() {
    for error in [
        HduError::Http(404),
        HduError::RequestTimeout,
        HduError::Network("sensitive upstream text".into()),
    ] {
        let f = Fake::new();
        let db = store();
        let p = f.preview(&db).await;
        *f.response.borrow_mut() = Some(Err(error));
        f.after.borrow_mut().clear();
        let r = f.run(&db, &p).await;
        assert_eq!(r["state"], "UNKNOWN");
        f.run(&db, &p).await;
        assert_eq!(f.writes.get(), 1);
        assert!(!r.to_string().contains("sensitive"));
    }
}
#[tokio::test]
async fn record_must_match_date_duration_seat_and_room() {
    for key in ["time", "duration", "seatNum", "roomName", "status"] {
        let f = Fake::new();
        let db = store();
        let p = f.preview(&db).await;
        f.after.borrow_mut()[0][key] = json!("incorrect");
        let r = f.run(&db, &p).await;
        assert_eq!(r["state"], "UNKNOWN");
        assert_eq!(r["recordVerified"], false);
    }
}
#[tokio::test]
async fn verification_404_remains_unknown() {
    let f = Fake::new();
    let db = store();
    let p = f.preview(&db).await;
    f.verify_error.set(true);
    let r = f.run(&db, &p).await;
    assert_eq!(r["state"], "UNKNOWN");
    assert_eq!(r["verificationError"], "HTTP_404");
    assert_eq!(f.writes.get(), 1);
}
#[tokio::test]
async fn explicit_rejection_auth_and_limit_never_retry() {
    for (response, reason) in [
        (Err(HduError::Http(429)), "LIMITED"),
        (
            Err(HduError::AuthenticationExpired("private".into())),
            "AUTH_REQUIRED",
        ),
        (
            Ok(json!({"CODE":"ParamError","DATA":{"msg":"超出可预约座位时间范围"}})),
            "NOT_OPEN",
        ),
        (
            Ok(json!({"CODE":"ParamError","DATA":{"msg":"已有预约，请勿重复预约！"}})),
            "EXISTING",
        ),
        (Ok(json!({"CODE":"1","MESSAGE":"请求过于频繁"})), "LIMITED"),
    ] {
        let f = Fake::new();
        let db = store();
        let p = f.preview(&db).await;
        *f.response.borrow_mut() = Some(response);
        f.after.borrow_mut().clear();
        let r = f.run(&db, &p).await;
        assert_eq!(r["state"], "STOPPED");
        assert_eq!(r["reason"], reason);
        assert_eq!(f.writes.get(), 1);
    }
}
#[tokio::test]
async fn explicit_confirmation_and_gate_are_both_mandatory() {
    let f = Fake::new();
    let db = store();
    let p = f.preview(&db).await;
    for (confirmation, rules, gate) in [
        (p.selection.confirmation(), true, false),
        (p.selection.confirmation(), false, true),
        ("162".into(), true, true),
    ] {
        assert!(submit(&db, &f, &p.ticket, &confirmation, rules, gate)
            .await
            .is_err());
    }
    assert_eq!(f.writes.get(), 0);
    assert!(db.manual_result(&f.uid()).unwrap().is_none());
}
#[tokio::test]
async fn occupied_conflicting_expired_session_and_changed_id_block_before_write() {
    for case in [
        "occupied",
        "conflict",
        "auth",
        "changed",
        "missing",
        "duplicate",
    ] {
        let f = Fake::new();
        let db = store();
        let p = f.preview(&db).await;
        match case {
            "occupied" => f.floors.borrow_mut()[0]["seatMap"]["POIs"][0]["state"] = json!("1"),
            "conflict" => *f.before.borrow_mut() = f.after.borrow().clone(),
            "auth" => f.authenticated.set(false),
            "changed" => f.floors.borrow_mut()[0]["seatMap"]["POIs"][0]["id"] = json!("different"),
            "missing" => f.floors.borrow_mut().clear(),
            "duplicate" => {
                let floor = f.floors.borrow()[0].clone();
                f.floors.borrow_mut().push(floor);
            }
            _ => unreachable!(),
        }
        assert!(
            submit(&db, &f, &p.ticket, &p.selection.confirmation(), true, true)
                .await
                .is_err(),
            "{case}"
        );
        assert_eq!(f.writes.get(), 0);
        assert!(db.manual_result(&f.uid()).unwrap().is_none());
    }
}
#[tokio::test]
async fn two_tickets_and_concurrent_submit_share_one_budget() {
    let f = Fake::new();
    let db = store();
    let p = f.preview(&db).await;
    let q = f.preview(&db).await;
    let (a, b) = tokio::join!(f.run(&db, &p), f.run(&db, &q));
    assert_eq!(a["state"], "SUCCESS");
    assert_eq!(b["state"], "UNKNOWN");
    assert_eq!(f.writes.get(), 1);
    assert_eq!(f.run(&db, &q).await["ticket"], p.ticket);
}
#[tokio::test]
async fn restart_after_persisted_intent_never_resubmits() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    let f = Fake::new();
    let db = Store::open(&path).unwrap();
    let p = f.preview(&db).await;
    assert!(db
        .manual_claim(&f.uid(), &p.ticket, r#"{"state":"UNKNOWN","attempts":1}"#)
        .unwrap());
    drop(db);
    let db = Store::open(&path).unwrap();
    assert_eq!(f.run(&db, &p).await["state"], "UNKNOWN");
    assert_eq!(f.writes.get(), 0);
    assert_eq!(f.reads.get(), 2);
}
#[tokio::test]
async fn unknown_or_closed_date_contract_is_never_guessed() {
    for v in [
        json!(2),
        json!(null),
        json!("tomorrow"),
        json!("2000-01-01"),
    ] {
        let f = Fake::new();
        f.range.borrow_mut()["max_date"] = v;
        assert!(prepare(&f, f.selection.clone()).await.is_err());
        assert_eq!(f.writes.get(), 0);
    }
    let f = Fake::new();
    f.range.borrow_mut()["max_duration"] = json!("not-a-number");
    assert!(prepare(&f, f.selection.clone()).await.is_err());
}
#[test]
fn time_zone_duration_and_seat_allowlist() {
    let f = Fake::new();
    let mut s = f.selection.clone();
    let old = s.begin().unwrap();
    s.date += Duration::days(1);
    assert_eq!(s.begin().unwrap() - old, Duration::days(1));
    assert_eq!(s.hours, 1);
    assert_eq!(
        s.begin()
            .unwrap()
            .with_timezone(&Shanghai)
            .format("%H:%M")
            .to_string(),
        "09:00"
    );
    s.seat = "158".into();
    assert!(s.begin().is_err());
    s.seat = "157".into();
    s.start_hour = 23;
    s.hours = 2;
    assert!(s.begin().is_err());
}
#[tokio::test]
async fn inspect_redacts_identity_and_unknown_upstream_fields() {
    let f = Fake::new();
    f.range.borrow_mut()["max_date"] = json!({"cookie":"private"});
    let r = inspect(&f).await.unwrap();
    assert_eq!(r["dateContractSupported"], false);
    assert!(!r.to_string().contains(&f.uid()));
    assert!(!r.to_string().contains("private"));
    assert_eq!(f.writes.get(), 0);
}

#[tokio::test]
async fn http_adapter_reuses_signed_one_hour_write_and_verifies_once() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use wiremock::matchers::{body_string_contains, header_exists, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};
    let http = MockServer::start().await;
    let fixture = Fake::new();
    let template = || ResponseTemplate::new(200).insert_header("Date", Utc::now().to_rfc2822());
    Mock::given(method("GET"))
        .and(path("/User/Center/baseInfo"))
        .respond_with(
            template()
                .set_body_json(json!({"CODE":"ok","DATA":{"is_login":true,"uid":fixture.uid()}})),
        )
        .expect(2)
        .mount(&http)
        .await;
    Mock::given(method("GET")).and(path("/Space/Category/list"))
        .respond_with(template().set_body_json(json!({"content":{"defaultItems":[{"name":"自习室","link":"/Seat/Index/searchSeats?space_category[category_id]=3&space_category[content_id]=93"}]}}))).expect(2).mount(&http).await;
    Mock::given(method("GET")).and(path("/Seat/Index/searchSeats"))
        .respond_with(template().set_body_json(json!({"data":{"range":*fixture.range.borrow(),"space_category":{"category_id":3,"content_id":93}}}))).mount(&http).await;
    Mock::given(method("POST")).and(path("/Seat/Index/searchSeats"))
        .and(body_string_contains("duration=3600")).and(body_string_contains("num=1"))
        .respond_with(template().set_body_json(json!({"allContent":{"children":[{}, {}, {"children":{"children":*fixture.floors.borrow()}}]}}))).expect(2).mount(&http).await;
    let written = Arc::new(AtomicBool::new(false));
    let flag = written.clone();
    let record = fixture.after.borrow().clone();
    Mock::given(method("GET")).and(path("/Seat/Index/myBookingList"))
        .respond_with(move |_:&wiremock::Request| ResponseTemplate::new(200).set_body_json(json!({"content":{"defaultItems":if flag.load(Ordering::SeqCst) {record.clone()} else {vec![]}}})))
        .expect(3).mount(&http).await;
    let flag = written.clone();
    Mock::given(method("POST"))
        .and(path("/Seat/Index/bookSeats"))
        .and(body_string_contains("duration=3600"))
        .and(body_string_contains("seats%5B0%5D=real-162"))
        .and(body_string_contains(format!(
            "beginTime={}",
            fixture.selection.begin().unwrap().timestamp()
        )))
        .and(body_string_contains(format!(
            "seatBookers%5B0%5D={}",
            fixture.uid()
        )))
        .and(header_exists("api-token"))
        .respond_with(move |_: &wiremock::Request| {
            flag.store(true, Ordering::SeqCst);
            ResponseTemplate::new(200)
                .set_body_json(json!({"CODE":"ok","DATA":{"result":"success"}}))
        })
        .expect(1)
        .mount(&http)
        .await;
    let client = LibraryClient::with_base_url(&http.uri()).unwrap();
    client.set_identity(fixture.uid(), String::new());
    let live = super::live::Live(&client);
    let db = store();
    let p = prepare(&live, fixture.selection.clone()).await.unwrap();
    db.manual_preview(
        &p.ticket,
        &live.uid(),
        &serde_json::to_string(&p).unwrap(),
        Utc::now().timestamp() + 300,
    )
    .unwrap();
    let r = submit(
        &db,
        &live,
        &p.ticket,
        &p.selection.confirmation(),
        true,
        true,
    )
    .await
    .unwrap();
    assert_eq!(r["state"], "SUCCESS");
    assert!(written.load(Ordering::SeqCst));
    assert!(r["timings"]["http"]["dispatchAt"].is_string());
    let total = r["timings"]["http"]["totalRequestMs"].as_f64().unwrap();
    let headers = r["timings"]["http"]["dispatchToHeadersMs"]
        .as_f64()
        .unwrap();
    assert!(headers >= 0.0 && total >= headers);
    assert!(r["timings"]["http"]["bodyDecodeMs"].as_f64().unwrap() >= 0.0);
    assert!(r["timings"]["http"]["requestUploadMs"].is_null());
    assert!(r["timings"]["http"]["serverProcessingMs"].is_null());
}

#[tokio::test]
async fn unsupported_date_contract_never_queries_slot_or_writes_over_http() {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};
    let http = MockServer::start().await;
    let fixture = Fake::new();
    Mock::given(path("/User/Center/baseInfo"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"DATA":{"is_login":true,"uid":fixture.uid()}})),
        )
        .mount(&http)
        .await;
    Mock::given(path("/Space/Category/list")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"content":{"defaultItems":[{"name":"自习室","link":"/Seat/Index/searchSeats?space_category[category_id]=3"}]}}))).mount(&http).await;
    Mock::given(method("GET"))
        .and(path("/Seat/Index/searchSeats"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"data":{"range":{"advance_date":0,"max_date":2}}})),
        )
        .mount(&http)
        .await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(500))
        .expect(0)
        .mount(&http)
        .await;
    let client = LibraryClient::with_base_url(&http.uri()).unwrap();
    client.set_identity(fixture.uid(), String::new());
    let err = prepare(&super::live::Live(&client), fixture.selection)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("UNSUPPORTED_DATE_CONTRACT"));
}

#[tokio::test]
async fn explicitly_selected_157_is_one_write_with_no_automatic_162_attempt() {
    let mut f = Fake::new();
    f.selection.seat = "157".into();
    f.after.borrow_mut()[0]["seatNum"] = json!("157");
    let db = store();
    let p = f.preview(&db).await;
    let r = f.run(&db, &p).await;
    assert_eq!(r["state"], "SUCCESS");
    assert_eq!(r["selection"]["seat"], "157");
    assert_eq!(f.writes.get(), 1);
}
