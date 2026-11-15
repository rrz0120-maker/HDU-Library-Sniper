# P5 离线验证记录

本阶段基于 `feat/cloud-strict-v3` 的 P4 提交 `84ee9ac` 继续，原 `a3ae4a1` 位于完整祖先链中。未改变 V3 预约顺序、重试/止损算法或前端。

| 项目 | 状态及证据 |
|---|---|
| 独立测试命令 | 已开发：inspect / prepare / submit / status；使用原 Rust 签名和单次请求路径 |
| Rust 单元及集成测试 | **158 通过，0 失败**；覆盖 core/auth/hdu/store/server，含 20 项新增 P5 测试 |
| HTTP 模拟 | 已通过：1 小时完整签名请求、官方记录精确核对、未知日期契约零 POST |
| 异常与防重复 | 已通过：超时后已成功、超时/404 后 UNKNOWN、限流/认证/未开放、记录不匹配、映射变化、重复票据、跨连接竞争、重启后意图不重发、157 单独选择 |
| Rust 检查 | fmt、clippy `--all-targets -- -D warnings` 退出码 0；现有 Cargo manifest 提示仍存在，不涉及代码检查失败 |
| Linux amd64 二进制 | `cargo build --offline --locked -p hdu-sniper-server` 成功；`target/debug/hdu-sniper-server` 可执行 |
| 实际命令行离线冒烟 | 已通过：help、缺密钥/数据库/会话止损、模拟 UNKNOWN 持久化后 status/prepare/submit 不重放、不输出 UID |
| 容器 | P5 已加入独立写入门禁默认关闭及 CLI 冒烟检查；构建结果以本提交 GitHub Actions 为准 |
| Web UI | 本阶段未修改；没有重跑移动端 UI 测试，沿用 P4 已验证页面 |
| 真实账号只读检查 | **未执行**：仅收到官方预约网址，未获得运行机器中的已登录会话 |
| 真实预约 / 生产部署 | **未执行**；真实写入、每日模式、自动签到保持关闭 |
| V3.1 | 未开发，等待普通时段真实验收成功 |

本次 Cloud 工作区证据：`/workspace/HDU-v3-verification/p5-rust-tests.log`、`p5-clippy.log`、`p5-format.log`、`p5-build.log`、`p5-cli-smoke.json`。首轮失败日志 `p5-rust-tests-attempt1.log` 保留：单个断言误用浮点 JSON 精确相等，已改为核对持久化任务的业务字段并通过复验。

测试严格使用内存模拟、本地 HTTP mock 和临时 SQLite，不使用校园凭据，不向馆方写入。测试中的 ID、UID、预约记录、ISO 日期字段均为合成数据。**实际 `advance_date/max_date` 类型仍需只读核实；不支持的类型会阻止提交，不能把模拟契约视作生产事实。**

按 [P5 使用步骤](P5-MANUAL-TEST.md) 先完成只读检查，再提供用户确认的具体座位、日期及短时段；在此之前不能开启测试写入门禁。备份应保留整个原数据卷及密钥，不得通过回滚/删除数据库恢复单次额度。
