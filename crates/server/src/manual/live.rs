use super::*;

pub(super) struct Live<'a>(pub &'a LibraryClient);
impl Gateway for Live<'_> {
    fn now(&self) -> DateTime<Utc> {
        self.0.booking_now()
    }
    fn uid(&self) -> String {
        self.0.uid()
    }
    async fn identity(&self) -> std::result::Result<bool, HduError> {
        self.0.validate_once_result().await
    }
    async fn catalog(&self, selection: Option<&Selection>) -> Result<(Value, Vec<Value>)> {
        let rooms = self
            .0
            .room_types()
            .await
            .map_err(|e| anyhow::anyhow!("CATALOG_{}", category(&e)))?;
        let rooms: Vec<_> = rooms.iter().filter(|r| r.name == "自习室").collect();
        anyhow::ensure!(rooms.len() == 1, "MAPPING_INVALID: 自习室缺失或不唯一");
        let query = &rooms[0].query;
        let range = self
            .0
            .booking_range_raw(query)
            .await
            .map_err(|e| anyhow::anyhow!("RANGE_{}", category(&e)))?;
        let floors = if let Some(s) = selection {
            // Do not even query a future/unopened slot before validating its bounds.
            validate_range(&range, s, self.now())?;
            anyhow::ensure!(
                self.0.clock_is_sane(),
                "CLOCK_UNVERIFIED: 请校准系统时钟或核实服务端Date响应头"
            );
            self.0
                .floors(query, s.begin()?, s.hours)
                .await
                .map_err(|e| anyhow::anyhow!("SEAT_QUERY_{}", category(&e)))?
        } else {
            vec![]
        };
        Ok((range, floors))
    }
    async fn records(&self) -> std::result::Result<Vec<Value>, HduError> {
        self.0.bookings().await
    }
    async fn submit(
        &self,
        seat: &str,
        begin: DateTime<Utc>,
        hours: i64,
    ) -> (std::result::Result<Value, HduError>, HttpTimings) {
        self.0.book_seat_once_timed(seat, begin, hours).await
    }
}
