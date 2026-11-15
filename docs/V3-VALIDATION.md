# V3 验收与验证记录

> 本页为P3离线结果；后续Docker/GitHub部署验收见 [P4验收记录](V3-P4-ACCEPTANCE.md)。

本文件区分本地模拟、构建和真实服务验证；没有任何真实预约成功声明。

## 当前结果（2026-11-14）

| 项目 | 结果 |
|---|---|
| P0审计 / 严格Rust执行器 / 持久化保护 / 移动UI | 已开发 |
| Rust五个crate + HTTP路由集成 | 138 passed，0 failed（含18个严格状态机用例、3个单次HTTP/时钟用例、独立操作系统进程竞争测试） |
| 前端Vitest | 34 passed，0 failed |
| Chromium 桌面/手机 E2E | 7 passed；1个原有桌面专属表单测试在手机跳过 |
| WebKit iPad 横屏/竖屏 E2E | 2 passed；Linux WebKit模拟，非真实iPad设备 |
| TypeScript / Biome / Rustfmt / Clippy | 通过；Cargo有基线清单字段未使用警告，不影响Clippy代码检查 |
| CI重复代码门槛 | 0.52%重复行，低于3% |
| Vite生产前端构建 | 通过 |
| Rust原生dev构建及启动健康 | 通过；HTTP健康、二进制 `--healthcheck`、SPA深链接200 |
| 完整Docker镜像构建 / 容器内健康 | **未通过环境验证**：拉取rust:1.99-bookworm层时Docker存储空间不足；未声称构建成功 |
| Podman运行 / Linux开机恢复实机 | 未执行；已提供配置、脚本和操作步骤 |
| 云服务器部署 / 安全外部访问 | 未执行 |
| 真实登录 / 只读座位映射 / 真实预约 | 未执行，等待明确授权与真实环境 |

WebKit运行库解压到本地工作区，并让本次下载的测试浏览器加载这些库；没有修改项目WebKit代码。CI使用正常 `playwright install --with-deps`。容器构建和无网络容器健康已加入PR/手动CI任务，CI是否通过须查看实际运行结果，不能由本地结果推断。

## 复现命令

```bash
bun install --frozen-lockfile
bun run check
bun run typecheck
bun run test
bun run build
bun x playwright install --with-deps chromium webkit
bun run test:e2e
cargo fmt --all -- --check
cargo clippy -p hdu-sniper-core -p hdu-sniper-hdu -p hdu-sniper-auth -p hdu-sniper-store -p hdu-sniper-server --all-targets -- -D warnings
cargo test -p hdu-sniper-core -p hdu-sniper-hdu -p hdu-sniper-auth -p hdu-sniper-store -p hdu-sniper-server
cargo build -p hdu-sniper-server
python3 scripts/v3-smoke.py
docker build -f Containerfile -t hdu-v3-review .
```

测试需要本机回环端口。测试夹具只使用合成UID、Mock服务器，不使用校园Cookie。`v3-smoke.py` 使用临时空数据库和随机临时加密密钥，不会发起馆方请求。

## 必须场景与证据

主要用例在 `crates/server/src/strict/tests.rs`；低层请求在 `crates/hdu/src/library/booking.rs`；HTTP集成在 `crates/server/tests/strict_api.rs`。

| # | 场景 | 自动测试 |
|---|---|---|
|1|162成功且一次写|primary_success_one_write|
|2|162明确占用、157成功|fallback_only_after_explicit_rejection（同时校验10秒节拍）|
|3|两座失败停止|both_unavailable_never_a_third_seat|
|4|超时但已有成功记录|timeout_with_confirmed_record_is_success|
|5|超时仍无法确认|timeout_404_and_early_response_are_unknown_without_fallback|
|6|读/写404不切备用|read_404_blocks_writes_and_read_failure_after_reject_blocks_fallback + 上一项|
|7|限流停止|throttle_and_expired_auth_stop_immediately|
|8|已有预约零写|existing_or_malformed_records_block_all_writes|
|9|重复点击唯一任务|stale_workers_and_duplicate_clicks_cannot_submit_twice + HTTP集成并发请求|
|10|每日20:00后天日期|dates_keep_fixed_hours_across_year_and_month_boundaries|
|11|改日期时间不丢失|同上；接口不接收用户日期/时长，统一生成08:00及50400秒|
|12|20:00前零正式写|no_preopening_write_preparation_is_read_only；低层clock_check_and_opening_gate_never_advance_ahead_of_server|
|13|缓存ID错误禁写|invalid_or_stale_mapping_blocks_write（修改为非空错误ID仍被校验和挡住）|
|14|157失败不尝试其他|both_unavailable_never_a_third_seat|
|15|重启不重复|independent_connections_and_restart_preserve_write_intent + timeout用例重新加载任务 + store::strict两个OS进程抢同一任务|
|16|登录失效停止提示|auth_preflight_failure_has_zero_writes + throttle_and_expired_auth_stop_immediately|

补充：停止等待中的备用提交、停止与每日创建竞态、错误/重复房间与编号、字段缺失记录、未授权写入门禁、过期任务、单次请求禁止认证重放/307跟随、旧取消/签到/通用预约路由阻断。

## 真实账号前检查清单（尚未执行）

- [ ] 馆方明确允许该使用方式；用户授权登录及只读检查。
- [ ] 容器镜像在目标服务器构建通过，健康检查通过。
- [ ] 仅回环发布；Tailscale/认证代理ACL只允许本人，HTTPS和Host白名单正确。
- [ ] 密钥与数据卷权限、备份和恢复流程验证；没有将敏感数据提交Git。
- [ ] NTP已同步；服务端Date可获取且偏差可接受。
- [ ] 真实目录确认自习室→宋韵云图确为四楼；162/157的唯一内部ID，缓存有效期与校验正常。
- [ ] 馆方当前仍允许20:00开放后天08:00–22:00、14小时、1人。
- [ ] 无已有时段冲突；账号会话有效，无验证码或封禁。
- [ ] 用户另行授权一次真实预约；不取消/修改已有预约，不连续占用释放。
- [ ] 通过预约记录核实实际结果并保存脱敏验收记录。
- [ ] 完成后才设置VALIDATED=1，由用户打开每日模式。
- [ ] 在目标服务器验证断开手机、进程重启和服务器重启时仍保留任务及审计；不回滚任务数据库到写前状态。

## 已知限制

真实预约规则与房间名称尚未在线核验，成功率无保证；缓存10分钟内馆方变化仍有风险。HTTP Date粗校时不能替代NTP。中断的进行中任务不重新认领；手动停止不撤回已在途的请求。同一目标的终态没有“重置”入口，无写入验收终止的日期也保留保护。重试新日期需要用户操作或已授权每日模式。

多个独立数据库实例、其他客户端同时预约、手动删除/回滚任务表不在幂等保护范围。SQLite幂等保证不能改变上游服务的最终一致性，因此UNKNOWN必须保留并由用户核验。
