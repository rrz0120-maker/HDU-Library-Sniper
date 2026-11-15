//! P5 namespace and permanent per-account one-write budget. No delete/reset API.
use super::*;
impl Store {
    pub fn manual_preview(
        &self,
        ticket: &str,
        uid: &str,
        document: &str,
        expires: i64,
    ) -> Result<()> {
        self.lock()?.execute(
            "INSERT INTO manual_previews VALUES(?1,?2,?3,?4)",
            params![ticket, uid, document, expires],
        )?;
        Ok(())
    }
    pub fn manual_load(&self, ticket: &str, uid: &str) -> Result<Option<(String, i64)>> {
        Ok(self
            .lock()?
            .query_row(
                "SELECT document,expires FROM manual_previews WHERE ticket=?1 AND uid=?2",
                params![ticket, uid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?)
    }
    pub fn manual_result(&self, uid: &str) -> Result<Option<String>> {
        Ok(self
            .lock()?
            .query_row(
                "SELECT result FROM manual_writes WHERE uid=?1",
                [uid],
                |r| r.get(0),
            )
            .optional()?)
    }
    pub fn manual_claim(&self, uid: &str, ticket: &str, pending: &str) -> Result<bool> {
        let mut conn = self.lock()?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let enabled: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM meta WHERE key='strict_daily_uid' AND value<>'')",
            [],
            |r| r.get(0),
        )?;
        let active: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM strict_tasks WHERE json_extract(document,'$.uid')=?1 AND json_extract(document,'$.state') NOT IN ('SUCCESS','FAILED','STOPPED','EXISTING','AUTH_REQUIRED','LIMITED'))",[uid],|r|r.get(0))?;
        if enabled || active {
            return Err(StoreError::Invalid(
                "PRODUCTION_TASK_ACTIVE: 请先停止生产任务；不确定任务须先人工核验".into(),
            ));
        }
        let changed=tx.execute("INSERT OR IGNORE INTO manual_writes(uid,ticket,result) SELECT ?1,?2,?3 WHERE EXISTS(SELECT 1 FROM manual_previews WHERE ticket=?2 AND uid=?1 AND expires>=?4)",params![uid,ticket,pending,Utc::now().timestamp()])?==1;
        tx.commit()?;
        Ok(changed)
    }
    pub fn manual_finish(&self, uid: &str, ticket: &str, result: &str) -> Result<()> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE manual_writes SET result=?3 WHERE uid=?1 AND ticket=?2",
            params![uid, ticket, result],
        )?;
        tx.execute(
            "INSERT INTO audit(event,payload,created_at) VALUES('manual_test_result',?1,?2)",
            params![result, Utc::now().to_rfc3339()],
        )?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn separate_connections_race_and_restart_cannot_restore_budget() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db.sqlite");
        let db = Store::open(&path).unwrap();
        for ticket in ["first", "second"] {
            db.manual_preview(ticket, "u", "{}", Utc::now().timestamp() + 300)
                .unwrap();
        }
        db.strict_create("production", r#"{"uid":"u","state":"STOPPED"}"#)
            .unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let workers: Vec<_> = ["first", "second"]
            .into_iter()
            .map(|ticket| {
                let db = Store::open(&path).unwrap();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    db.manual_claim("u", ticket, "UNKNOWN").unwrap()
                })
            })
            .collect();
        assert_eq!(
            workers
                .into_iter()
                .filter_map(|w| w.join().ok())
                .filter(|v| *v)
                .count(),
            1
        );
        drop(db);
        let db = Store::open(&path).unwrap();
        assert!(!db.manual_claim("u", "first", "UNKNOWN").unwrap());
        assert_eq!(db.manual_result("u").unwrap().as_deref(), Some("UNKNOWN"));
        let doc: String = db
            .lock()
            .unwrap()
            .query_row(
                "SELECT document FROM strict_tasks WHERE task_key='production'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(doc, r#"{"uid":"u","state":"STOPPED"}"#);
    }
    #[test]
    fn invalid_expired_and_other_account_tickets_spend_no_budget() {
        let db = Store::open(":memory:").unwrap();
        db.manual_preview("expired", "u", "{}", 1).unwrap();
        db.manual_preview("other", "v", "{}", Utc::now().timestamp() + 300)
            .unwrap();
        for ticket in ["missing", "expired", "other"] {
            assert!(!db.manual_claim("u", ticket, "UNKNOWN").unwrap());
        }
        assert!(db.manual_result("u").unwrap().is_none());
    }
    #[test]
    fn active_production_and_unknown_tasks_prevent_manual_writes() {
        for state in ["WAITING", "BOOKING_162", "UNKNOWN"] {
            let db = Store::open(":memory:").unwrap();
            db.manual_preview("p", "u", "{}", Utc::now().timestamp() + 300)
                .unwrap();
            db.strict_create(
                "production",
                &serde_json::json!({"uid":"u","state":state}).to_string(),
            )
            .unwrap();
            assert!(db.manual_claim("u", "p", "UNKNOWN").is_err());
            assert!(db.manual_result("u").unwrap().is_none());
        }
    }
}
