use super::parse::*;
use super::*;

impl LibraryClient {
    pub async fn bookings(&self) -> Result<Vec<Value>, HduError> {
        let body = self
            .request_json(
                "/Seat/Index/myBookingList?fromType=web&LAB_JSON=1",
                Method::GET,
                None,
                Vec::new(),
                READ_TIMEOUT,
            )
            .await?;
        body.get("content")
            .and_then(|content| content.get("defaultItems"))
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| HduError::Library("预约列表解析失败".into()))
    }

    pub async fn book_seat(
        &self,
        seat_id: &str,
        begin_time: DateTime<Utc>,
        duration_hours: i64,
    ) -> Result<Value, HduError> {
        self.book_seat_request(seat_id, begin_time, duration_hours, false, None)
            .await
    }

    /// Strict mode: exactly one HTTP write, no auth refresh replay or redirects.
    pub async fn book_seat_once(
        &self,
        seat_id: &str,
        begin_time: DateTime<Utc>,
        duration_hours: i64,
    ) -> Result<Value, HduError> {
        self.book_seat_request(seat_id, begin_time, duration_hours, true, None)
            .await
    }

    pub async fn book_seat_once_timed(
        &self,
        seat_id: &str,
        begin: DateTime<Utc>,
        hours: i64,
    ) -> (Result<Value, HduError>, HttpTimings) {
        let mut timing = HttpTimings::default();
        let result = self
            .book_seat_request(seat_id, begin, hours, true, Some(&mut timing))
            .await;
        (result, timing)
    }

    async fn book_seat_request(
        &self,
        seat_id: &str,
        begin_time: DateTime<Utc>,
        duration_hours: i64,
        once: bool,
        timing: Option<&mut HttpTimings>,
    ) -> Result<Value, HduError> {
        let local_start = std::time::Instant::now();
        let uid = self.uid();
        if uid.is_empty() {
            return Err(HduError::AuthenticationExpired("缺少用户 UID".into()));
        }
        let begin = begin_time.timestamp();
        let duration = duration_hours * 3600;
        let api_time = Utc::now().timestamp();
        let form = vec![
            ("beginTime".into(), begin.to_string()),
            ("duration".into(), duration.to_string()),
            ("is_recommend".into(), "0".into()),
            ("api_time".into(), api_time.to_string()),
            ("seats[0]".into(), seat_id.to_string()),
            ("seatBookers[0]".into(), uid.clone()),
        ];
        let token = api_token(seat_id, &uid, begin, duration, api_time);
        if once {
            let mut timing = timing;
            if let Some(t) = timing.as_deref_mut() {
                t.local_prepare_ms = local_start.elapsed().as_secs_f64() * 1000.0;
            }
            return self
                .request_json_once_measured(
                    "/Seat/Index/bookSeats?LAB_JSON=1",
                    Method::POST,
                    Some(form),
                    vec![("Api-Token".into(), token)],
                    WRITE_TIMEOUT,
                    timing,
                )
                .await;
        }
        self.request_json(
            "/Seat/Index/bookSeats?LAB_JSON=1",
            Method::POST,
            Some(form),
            vec![("Api-Token".into(), token)],
            WRITE_TIMEOUT,
        )
        .await
    }

    pub async fn lock_seat(
        &self,
        seat_id: &str,
        begin_time: DateTime<Utc>,
        duration_hours: i64,
    ) -> Result<Value, HduError> {
        let begin = begin_time.timestamp();
        let duration = duration_hours * 3600;
        let form = vec![
            ("beginTime".into(), begin.to_string()),
            ("duration".into(), duration.to_string()),
            ("is_recommend".into(), "0".into()),
            ("api_time".into(), Utc::now().timestamp().to_string()),
            ("seats[0]".into(), seat_id.to_string()),
        ];
        self.request_json(
            "/Seat/Index/lockSeats?LAB_JSON=1",
            Method::POST,
            Some(form),
            Vec::new(),
            WRITE_TIMEOUT,
        )
        .await
    }

    pub async fn unlock_all_seats(&self) -> Result<Value, HduError> {
        self.request_json(
            "/Seat/Index/unlockAllSeats?LAB_JSON=1",
            Method::POST,
            None,
            Vec::new(),
            WRITE_TIMEOUT,
        )
        .await
    }

    pub async fn action(&self, action: Action, booking_id: &str) -> Result<Value, HduError> {
        let encoded_id = urlencoding::encode(booking_id);
        if action == Action::Leave {
            let latest = self
                .request_json(
                    &format!(
                        "/Seat/Index/stepOutLatestComeBackTime?bookingId={encoded_id}&LAB_JSON=1"
                    ),
                    Method::POST,
                    None,
                    Vec::new(),
                    WRITE_TIMEOUT,
                )
                .await?;
            assert_action_success(&latest)?;
            let come_back_time = latest
                .get("DATA")
                .and_then(|data| data.get("latest_come_back_time"))
                .map(value_to_i64)
                .unwrap_or(0);
            if come_back_time <= 0 {
                return Err(HduError::Library("无法获取暂离返回时间".into()));
            }
            let body = self
                .request_json(
                    &format!("/Seat/Index/stepOut?bookingId={encoded_id}&LAB_JSON=1"),
                    Method::POST,
                    Some(vec![("comeBackTime".into(), come_back_time.to_string())]),
                    Vec::new(),
                    WRITE_TIMEOUT,
                )
                .await?;
            assert_action_success(&body)?;
            return Ok(body);
        }
        let endpoint = match action {
            Action::Cancel => "/Seat/Index/cancelBooking",
            Action::CheckIn => "/Seat/Index/checkIn",
            Action::ComeBack => "/Seat/Index/comeBack",
            Action::SignOut => "/Seat/Index/checkOut",
            Action::Leave => unreachable!(),
        };
        let body = self
            .request_json(
                &format!("{endpoint}?bookingId={encoded_id}&LAB_JSON=1"),
                Method::POST,
                None,
                Vec::new(),
                WRITE_TIMEOUT,
            )
            .await?;
        assert_action_success(&body)?;
        Ok(body)
    }
}

#[cfg(test)]
mod strict_tests {
    use super::*;
    use wiremock::matchers::{body_string_contains, header_exists, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};
    #[test]
    fn clock_check_and_opening_gate_never_advance_ahead_of_server() {
        let client = LibraryClient::with_base_url("http://127.0.0.1:1").unwrap();
        assert!(!client.clock_is_sane());
        let server = Utc::now().timestamp() - 2;
        *client.clock_sample.lock().unwrap() = Some((2, std::time::Instant::now(), server));
        assert!(client.clock_is_sane());
        assert_eq!(client.booking_now().timestamp(), server);
        *client.clock_sample.lock().unwrap() = Some((30, std::time::Instant::now(), server));
        assert!(!client.clock_is_sane());
    }
    #[tokio::test]
    async fn single_write_uses_current_contract_and_never_refreshes() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/Seat/Index/bookSeats"))
            .and(body_string_contains("duration=50400"))
            .and(body_string_contains("seats%5B0%5D=internal-id"))
            .and(body_string_contains("seatBookers%5B0%5D=123"))
            .and(header_exists("api-token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                serde_json::json!({"ui_type":"com.Redirect","href":"/User/Index/hduCASLogin"}),
            ))
            .expect(1)
            .mount(&server)
            .await;
        let client = LibraryClient::with_base_url(&server.uri()).unwrap();
        client.set_identity("123".into(), "".into());
        client.set_refresh_handler(Arc::new(|| {
            Box::pin(async { panic!("strict writes must never refresh") })
        }));
        assert!(matches!(
            client.book_seat_once("internal-id", Utc::now(), 14).await,
            Err(HduError::AuthenticationExpired(_))
        ));
    }
    #[tokio::test]
    async fn single_write_never_follows_redirect_or_retries_429() {
        for code in [307, 429] {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/Seat/Index/bookSeats"))
                .respond_with(
                    ResponseTemplate::new(code)
                        .insert_header("location", format!("{}/replay", server.uri())),
                )
                .expect(1)
                .mount(&server)
                .await;
            Mock::given(path("/replay"))
                .respond_with(ResponseTemplate::new(200))
                .expect(0)
                .mount(&server)
                .await;
            let client = LibraryClient::with_base_url(&server.uri()).unwrap();
            client.set_identity("123".into(), "".into());
            assert!(
                matches!(client.book_seat_once("id",Utc::now(),14).await,Err(HduError::Http(n)) if n==code)
            );
        }
    }
}
