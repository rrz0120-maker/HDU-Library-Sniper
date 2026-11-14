//! Single isolated integration-test process: strict env never races legacy tests.
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use hdu_sniper_auth::AuthService;
use hdu_sniper_server::{build_router, BookingExecutor, Scheduler};
use hdu_sniper_store::Store;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::sync::Arc;
use tower::ServiceExt;
async fn call(app: Router, path: &str, body: Value) -> (StatusCode, Value) {
    let r = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let code = r.status();
    let bytes = r.into_body().collect().await.unwrap().to_bytes();
    (code, serde_json::from_slice(&bytes).unwrap())
}
#[tokio::test]
async fn duplicate_mobile_requests_daily_gate_stop_and_legacy_write_isolation() {
    std::env::set_var("HDU_STRICT_MODE", "1");
    std::env::remove_var("HDU_STRICT_WRITES");
    std::env::remove_var("HDU_STRICT_VALIDATED");
    let s = Arc::new(Store::open_in_memory().unwrap());
    let auth = Arc::new(AuthService::new(s.clone()).unwrap());
    auth.client.set_identity("123".into(), "synthetic".into());
    let scheduler = Arc::new(Scheduler::new(
        s.clone(),
        auth.clone(),
        Arc::new(BookingExecutor::new(s.clone())),
    ));
    let app = build_router(s.clone(), auth, scheduler);
    let (a, b) = tokio::join!(
        call(app.clone(), "/api/strict/start", json!({})),
        call(app.clone(), "/api/strict/start", json!({}))
    );
    assert_eq!(a.0, StatusCode::OK);
    assert_eq!(b.0, StatusCode::OK);
    assert_eq!(s.strict_all().unwrap().len(), 1);
    assert!(a.1["tasks"][0].get("uid").is_none());
    assert_eq!(
        call(app.clone(), "/api/strict/daily", json!({"enabled":true}))
            .await
            .0,
        StatusCode::CONFLICT
    );
    for path in [
        "/api/booking/run",
        "/api/bookings/123/cancel",
        "/api/checkin/enable",
        "/api/plans",
    ] {
        assert_eq!(
            call(app.clone(), path, json!({})).await.0,
            StatusCode::CONFLICT
        );
    }
    assert_eq!(
        call(app.clone(), "/api/strict/stop", json!({})).await.1["tasks"][0]["state"],
        "STOPPED"
    );
    assert_eq!(
        call(app, "/api/strict/start", json!({})).await.1["tasks"][0]["state"],
        "STOPPED"
    );
}
