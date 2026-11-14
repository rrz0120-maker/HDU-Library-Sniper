use super::*;
use crate::{ApiError, AppState};
use axum::{extract::State, http::StatusCode, Json};
pub fn enabled() -> bool {
    std::env::var("HDU_STRICT_MODE").as_deref() == Ok("1")
}
fn gate() -> std::result::Result<(), ApiError> {
    if enabled() {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::CONFLICT,
            "此服务未启用严格云端模式",
        ))
    }
}
pub(crate) async fn status(
    State(s): State<AppState>,
) -> std::result::Result<Json<Value>, ApiError> {
    let uid = s.auth.client.uid();
    let mut tasks = vec![];
    for doc in s.store.strict_all()? {
        let t: Task = serde_json::from_str(&doc).map_err(StoreError::from)?;
        if t.uid == uid {
            tasks.push(json!({"date":t.date,"state":t.state,"message":t.message,"attempts":t.attempts,"updatedAt":t.updated_at}));
        }
    }
    Ok(Json(
        json!({"enabled":enabled(),"writesAllowed":live::writes_allowed(),
        "validated":std::env::var("HDU_STRICT_VALIDATED").as_deref()==Ok("1"),
        "daily":!uid.is_empty() && s.store.get_meta("strict_daily_uid")?.as_deref()==Some(&uid),
        "targetDate":Task::new(&uid,Utc::now()).date,"tasks":tasks}),
    ))
}
pub(crate) async fn start(State(s): State<AppState>) -> std::result::Result<Json<Value>, ApiError> {
    gate()?;
    Task::create(&s.store, &s.auth.client.uid(), Utc::now())?;
    status(State(s)).await
}
#[derive(Deserialize)]
pub struct Daily {
    enabled: bool,
}
pub(crate) async fn daily(
    State(s): State<AppState>,
    Json(input): Json<Daily>,
) -> std::result::Result<Json<Value>, ApiError> {
    gate()?;
    if input.enabled
        && (!live::writes_allowed() || std::env::var("HDU_STRICT_VALIDATED").as_deref() != Ok("1"))
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "真实预约验收未完成，每日自动模式保持关闭",
        ));
    }
    let uid = s.auth.client.uid();
    s.store
        .set_meta("strict_daily_uid", if input.enabled { &uid } else { "" })?;
    status(State(s)).await
}
pub(crate) async fn stop(State(s): State<AppState>) -> std::result::Result<Json<Value>, ApiError> {
    gate()?;
    s.store.strict_stop(&s.auth.client.uid())?;
    status(State(s)).await
}
pub(crate) async fn check_login(
    State(s): State<AppState>,
) -> std::result::Result<Json<Value>, ApiError> {
    let valid = s.auth.client.validate_once().await;
    Ok(Json(
        json!({"valid":valid,"clockSane":s.auth.client.clock_is_sane()}),
    ))
}
pub async fn worker(store: Arc<Store>, auth: Arc<hdu_sniper_auth::AuthService>) {
    live::run(store, auth).await;
}
