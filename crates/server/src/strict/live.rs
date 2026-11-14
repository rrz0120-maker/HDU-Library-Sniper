use super::*;
pub(super) struct Live<'a>(pub &'a LibraryClient);
impl Gateway for Live<'_> {
    fn now(&self) -> DateTime<Utc> {
        self.0.booking_now()
    }
    async fn identity(&self, uid: &str) -> bool {
        self.0.validate_once().await && self.0.uid() == uid && self.0.clock_is_sane()
    }
    async fn records(&self) -> std::result::Result<Vec<Value>, HduError> {
        self.0.bookings().await
    }
    async fn submit(&self, id: &str, begin: i64) -> std::result::Result<Value, HduError> {
        self.0
            .book_seat_once(id, DateTime::from_timestamp(begin, 0).unwrap(), 14)
            .await
    }
    async fn pace(&self) {
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
    }
    async fn prepare(&self) -> std::result::Result<Mapping, HduError> {
        let fail = || HduError::Library("无法唯一验证宋韵云图及 162/157 内部 ID".into());
        let rooms: Vec<_> = self
            .0
            .room_types()
            .await?
            .into_iter()
            .filter(|r| r.name == "自习室")
            .collect();
        if rooms.len() != 1 {
            return Err(fail());
        }
        let range = self.0.booking_range(&rooms[0].query).await?;
        if range.min_begin_time > 8
            || range.max_end_time < 22
            || range.min_duration > 14
            || range.max_duration < 14
        {
            return Err(fail());
        }
        // Tomorrow is already open BEFORE 20:00. Only resolve IDs, never infer target availability.
        let date = Utc::now().with_timezone(&Shanghai).date_naive() + Duration::days(1);
        let lookup = Shanghai
            .from_local_datetime(&date.and_hms_opt(8, 0, 0).unwrap())
            .single()
            .unwrap()
            .with_timezone(&Utc);
        let floors = self.0.floors(&rooms[0].query, lookup, 1).await?;
        resolve_mapping(&rooms[0].query, &floors, self.now().timestamp())
    }
}
pub(super) fn resolve_mapping(
    query: &str,
    floors: &[Value],
    now: i64,
) -> std::result::Result<Mapping, HduError> {
    let fail = || HduError::Library("座位映射无法唯一验证".into());
    let candidates: Vec<_> = floors
        .iter()
        .filter(|f| f["roomName"].as_str().is_some_and(target_room))
        .collect();
    if candidates.len() != 1 {
        return Err(fail());
    }
    let f = candidates[0];
    let seats = f["seatMap"]["POIs"].as_array().ok_or_else(fail)?;
    let mut ids = vec![];
    for number in ["162", "157"] {
        let matches: Vec<_> = seats
            .iter()
            .filter(|s| {
                s.get("title")
                    .map(value_to_string)
                    .is_some_and(|t| t.trim() == number)
            })
            .collect();
        if matches.len() != 1 {
            return Err(fail());
        }
        ids.push(matches[0].get("id").map(value_to_string).ok_or_else(fail)?);
    }
    let mut mapping = Mapping {
        room_query: query.into(),
        floor_id: value_to_i64(&f["seatMap"]["info"]["id"]),
        room_name: value_to_string(&f["roomName"]),
        ids: [ids[0].clone(), ids[1].clone()],
        verified_at: now,
        checksum: 0,
    };
    mapping.checksum = mapping_checksum(&mapping);
    if !valid_mapping(&mapping, now) {
        return Err(fail());
    }
    Ok(mapping)
}

pub async fn run(store: Arc<Store>, auth: Arc<hdu_sniper_auth::AuthService>) {
    loop {
        if run_tick(&store, &auth).await.is_err() {
            tracing::error!("strict scheduler storage error; no automatic write retry");
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}
async fn run_tick(store: &Store, auth: &hdu_sniper_auth::AuthService) -> Result<()> {
    let uid = auth.client.uid();
    let now = Utc::now();
    if writes_allowed()
        && std::env::var("HDU_STRICT_VALIDATED").as_deref() == Ok("1")
        && !uid.is_empty()
        && store.get_meta("strict_daily_uid")?.as_deref() == Some(&uid)
    {
        let template = Task::new(&uid, now);
        if now.timestamp() >= template.opens - 300 {
            store.strict_create_daily(&template.key, &serde_json::to_string(&template)?, &uid)?;
        }
    }
    for document in store.strict_all()? {
        let mut task: Task = serde_json::from_str(&document)?;
        // Intermediate claims are deliberately NEVER reclaimed, including after restart.
        if ["WAITING", "CHECKED", "READY"].contains(&task.state.as_str()) {
            tick(store, &mut task, &Live(&auth.client), writes_allowed()).await?;
        }
    }
    Ok(())
}
pub fn writes_allowed() -> bool {
    std::env::var("HDU_STRICT_WRITES").as_deref() == Ok("1")
}
