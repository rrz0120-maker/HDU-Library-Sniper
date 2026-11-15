use super::*;
use hdu_sniper_auth::{AesSecretStore, AuthService};
use std::{collections::BTreeMap, path::PathBuf, sync::Arc};

const HELP: &str = "独立单次验收（不启动调度器，不自动登录/取消）：
  --manual-test inspect
  --manual-test prepare --date YYYY-MM-DD --start H [--hours 1] [--seat 162]
  --manual-test submit --ticket UUID --confirm 'prepare输出的完整确认文字' --rules-allowed
  --manual-test status
需要现有 HDU_SNIPER_HOME 数据目录及原 HDU_SNIPER_SECRET_KEY。
submit 还需显式 HDU_MANUAL_TEST_WRITES=1；生产写入必须关闭。
同一账号整个P5验收最多一次写入，重启/换票/换时段不会恢复额度。";

fn flags(args: &[String], allowed: &[&str]) -> Result<BTreeMap<String, String>> {
    let mut flags = BTreeMap::new();
    let mut i = 0;
    while i < args.len() {
        let key = args[i].as_str();
        anyhow::ensure!(
            allowed.contains(&key) && !flags.contains_key(key),
            "INVALID_ARGUMENT: 未知或重复参数"
        );
        let value = if key == "--rules-allowed" {
            "true".to_string()
        } else {
            i += 1;
            args.get(i)
                .filter(|s| !s.starts_with("--"))
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("INVALID_ARGUMENT: 缺少参数值"))?
        };
        flags.insert(key.into(), value);
        i += 1;
    }
    Ok(flags)
}

/// No tracing subscriber, refresh callback, server, scheduler, or write retries.
pub async fn run(home: PathBuf, args: &[String]) -> Result<()> {
    if args.is_empty() || args == ["--help"] {
        println!("{HELP}");
        return Ok(());
    }
    match execute(home, args).await {
        Ok(value) => {
            println!("{}", serde_json::to_string_pretty(&value)?);
            Ok(())
        }
        Err(e) => {
            // Only our fixed codes are printable. Upstream error bodies, identity,
            // cookie jars, SQL errors and paths must never reach console/logs.
            let message = e.to_string();
            let code = message.split(':').next().unwrap_or("");
            let safe = !code.is_empty()
                && code.len() <= 64
                && code
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c == '_' || c.is_ascii_digit());
            eprintln!(
                "{}",
                json!({"mode":"MANUAL_TEST", "state":"STOPPED", "error":if safe {code} else {"LOCAL_ERROR"}, "message":"未启动后续写入；如已提交过，请用status查看持久化结果。"})
            );
            anyhow::bail!("manual test stopped; see redacted JSON above")
        }
    }
}

async fn execute(home: PathBuf, args: &[String]) -> Result<Value> {
    let (cmd, rest) = args.split_first().unwrap();
    let allowed: &[&str] = match cmd.as_str() {
        "inspect" | "status" => &[],
        "prepare" => &["--date", "--start", "--hours", "--seat"],
        "submit" => &["--ticket", "--confirm", "--rules-allowed"],
        _ => anyhow::bail!("INVALID_ARGUMENT: 未知命令"),
    };
    let flags = flags(rest, allowed)?;
    let required = |key: &str| {
        flags
            .get(key)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("INVALID_ARGUMENT: 缺少必要参数"))
    };
    anyhow::ensure!(
        AesSecretStore::from_env().is_some(),
        "SECRET_KEY_REQUIRED: 必须使用现有加密密钥"
    );
    anyhow::ensure!(
        std::env::var("HDU_STRICT_WRITES").as_deref() != Ok("1"),
        "PRODUCTION_WRITES_ENABLED: 请关闭生产写入"
    );
    let path = home.join("data/hdu-sniper.sqlite");
    anyhow::ensure!(
        path.is_file(),
        "SESSION_NOT_FOUND: 请先通过可信管理服务登录，不接受官方页面URL代替会话"
    );
    let store = Arc::new(Store::open(path).map_err(|_| anyhow::anyhow!("STORE_UNAVAILABLE"))?);
    let auth =
        AuthService::new(store.clone()).map_err(|_| anyhow::anyhow!("SESSION_UNAVAILABLE"))?;
    anyhow::ensure!(
        !auth.client.uid().is_empty(),
        "AUTH_REQUIRED: 无已保存的登录会话"
    );
    let live = super::live::Live(&auth.client);
    match cmd.as_str() {
        "inspect" => inspect(&live).await,
        "status" => Ok(store
            .manual_result(&live.uid())?
            .map(|s| serde_json::from_str(&s))
            .transpose()?
            .unwrap_or(json!({"mode":"MANUAL_TEST","state":"NOT_STARTED","attempts":0}))),
        "prepare" => {
            if let Some(result) = store.manual_result(&live.uid())? {
                return Ok(serde_json::from_str(&result)?);
            }
            let selection = Selection {
                date: required("--date")?
                    .parse()
                    .map_err(|_| anyhow::anyhow!("INVALID_SELECTION: 日期格式无效"))?,
                start_hour: required("--start")?
                    .parse()
                    .map_err(|_| anyhow::anyhow!("INVALID_SELECTION: 开始小时无效"))?,
                hours: flags
                    .get("--hours")
                    .map(String::as_str)
                    .unwrap_or("1")
                    .parse()
                    .map_err(|_| anyhow::anyhow!("INVALID_SELECTION: 时长无效"))?,
                seat: flags.get("--seat").cloned().unwrap_or_else(|| "162".into()),
            };
            selection.begin()?;
            let preview = prepare(&live, selection).await?;
            let expires = Utc::now().timestamp() + 300;
            store.manual_preview(
                &preview.ticket,
                &live.uid(),
                &serde_json::to_string(&preview)?,
                expires,
            )?;
            Ok(
                json!({"mode":"READ_ONLY", "state":"AWAITING_CONFIRMATION", "preview":preview, "expiresAt":expires, "confirmation":preview.selection.confirmation(), "message":"仅完成只读检查。确认馆方允许及完整座位日期时段后才能单次提交。"}),
            )
        }
        "submit" => {
            submit(
                &store,
                &live,
                &required("--ticket")?,
                &required("--confirm")?,
                flags.contains_key("--rules-allowed"),
                std::env::var("HDU_MANUAL_TEST_WRITES").as_deref() == Ok("1"),
            )
            .await
        }
        _ => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn flags_reject_unknown_duplicate_and_missing_values() {
        for args in [
            vec!["--password", "secret"],
            vec!["--seat"],
            vec!["--seat", "162", "--seat", "157"],
        ] {
            assert!(flags(
                &args.into_iter().map(String::from).collect::<Vec<_>>(),
                &["--seat"]
            )
            .is_err());
        }
        assert!(flags(&["--rules-allowed".into()], &["--rules-allowed"])
            .unwrap()
            .contains_key("--rules-allowed"));
    }
}
