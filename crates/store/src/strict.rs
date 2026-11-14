//! Durable compare-and-swap: reservation intent is committed BEFORE network I/O.
use super::*;
impl Store {
    pub fn strict_create(&self, key: &str, document: &str) -> Result<()> {
        self.lock()?.execute(
            "INSERT OR IGNORE INTO strict_tasks VALUES (?1, ?2)",
            params![key, document],
        )?;
        Ok(())
    }
    pub fn strict_create_daily(&self, key: &str, document: &str, uid: &str) -> Result<()> {
        self.lock()?.execute("INSERT OR IGNORE INTO strict_tasks SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM meta WHERE key='strict_daily_uid' AND value=?3)", params![key, document, uid])?;
        Ok(())
    }
    /// Stop and disable future daily creation in one transaction. Racing worker CAS loses.
    pub fn strict_stop(&self, uid: &str) -> Result<()> {
        let mut conn = self.lock()?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        tx.execute(
            "UPDATE meta SET value='' WHERE key='strict_daily_uid' AND value=?1",
            [uid],
        )?;
        let rows = {
            let mut stmt = tx.prepare("SELECT task_key, document FROM strict_tasks")?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows
        };
        for (key, doc) in rows {
            let mut v: serde_json::Value = serde_json::from_str(&doc)?;
            if v["uid"] != uid
                || [
                    "SUCCESS",
                    "EXISTING",
                    "FAILED",
                    "STOPPED",
                    "UNKNOWN",
                    "LIMITED",
                    "AUTH_REQUIRED",
                ]
                .contains(&v["state"].as_str().unwrap_or(""))
            {
                continue;
            }
            let attempted = v["attempts"].as_array().is_some_and(|a| !a.is_empty());
            v["state"] = serde_json::json!(if attempted { "UNKNOWN" } else { "STOPPED" });
            v["message"] = serde_json::json!(if attempted {
                "已停止后续写入；已发出的请求可能完成，请核对官方记录"
            } else {
                "已取消待命／手动接管；没有取消任何已有预约"
            });
            v["updated_at"] = serde_json::json!(Utc::now().timestamp());
            // Terminal states are never reclaimed or submitted again.
            tx.execute(
                "UPDATE strict_tasks SET document=?2 WHERE task_key=?1",
                params![key, v.to_string()],
            )?;
            tx.execute("INSERT INTO audit(event,payload,created_at) VALUES('strict_transition',?1,?2)",params![serde_json::json!({"date":v["date"],"state":v["state"],"message":v["message"],"attempts":v["attempts"]}).to_string(),Utc::now().to_rfc3339()])?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn strict_get(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .lock()?
            .query_row(
                "SELECT document FROM strict_tasks WHERE task_key=?1",
                [key],
                |r| r.get(0),
            )
            .optional()?)
    }
    pub fn strict_all(&self) -> Result<Vec<String>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare("SELECT document FROM strict_tasks ORDER BY task_key DESC")?;
        let rows = stmt
            .query_map([], |r| r.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    pub fn strict_cas(&self, key: &str, before: &str, after: &str) -> Result<bool> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        let changed = tx.execute(
            "UPDATE strict_tasks SET document=?3 WHERE task_key=?1 AND document=?2",
            params![key, before, after],
        )? == 1;
        if changed {
            let doc: serde_json::Value = serde_json::from_str(after)?;
            if ["UNKNOWN", "LIMITED", "AUTH_REQUIRED", "FAILED"]
                .contains(&doc["state"].as_str().unwrap_or(""))
            {
                tx.execute(
                    "UPDATE meta SET value='' WHERE key='strict_daily_uid' AND value=?1",
                    [doc["uid"].as_str().unwrap_or("")],
                )?;
            }
            // No UID, cookies, upstream messages or credentials in audit payloads.
            tx.execute("INSERT INTO audit(event,payload,created_at) VALUES('strict_transition',?1,?2)", params![serde_json::json!({"date":doc["date"],"state":doc["state"],"message":doc["message"],"attempts":doc["attempts"]}).to_string(), Utc::now().to_rfc3339()])?;
        }
        tx.commit()?;
        Ok(changed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const BEFORE: &str = r#"{"state":"READY"}"#;
    const AFTER: &str = r#"{"state":"SUBMITTING_162","uid":"synthetic"}"#;
    #[test]
    fn process_worker() {
        let Ok(path) = std::env::var("HDU_TEST_CAS_DATABASE") else {
            return;
        };
        let store = Store::open(path).unwrap();
        if store.strict_cas("same-task", BEFORE, AFTER).unwrap() {
            std::fs::write(std::env::var("HDU_TEST_CAS_WINNER").unwrap(), "claimed").unwrap();
        }
    }
    #[test]
    fn two_os_processes_have_exactly_one_durable_claim() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("tasks.sqlite");
        let store = Store::open(&db).unwrap();
        store.strict_create("same-task", BEFORE).unwrap();
        let exe = std::env::current_exe().unwrap();
        let mut children = Vec::new();
        for i in 0..2 {
            children.push(
                std::process::Command::new(&exe)
                    .args(["--exact", "strict::tests::process_worker"])
                    .env("HDU_TEST_CAS_DATABASE", &db)
                    .env(
                        "HDU_TEST_CAS_WINNER",
                        dir.path().join(format!("winner-{i}")),
                    )
                    .stdout(std::process::Stdio::null())
                    .spawn()
                    .unwrap(),
            );
        }
        for mut child in children {
            assert!(child.wait().unwrap().success());
        }
        assert_eq!(
            (0..2)
                .filter(|i| dir.path().join(format!("winner-{i}")).exists())
                .count(),
            1
        );
        drop(store);
        assert_eq!(
            Store::open(db)
                .unwrap()
                .strict_get("same-task")
                .unwrap()
                .as_deref(),
            Some(AFTER)
        );
    }
}
