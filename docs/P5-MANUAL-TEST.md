# P5 普通时段单次预约验收

此模式直接复用 Rust `book_seat_once` 的请求构造、签名、超时和禁止重放实现。没有新增预约 HTTP 实现，也不启动 Web 服务、每日调度、预锁、自动登录或自动签到。

**真实账号只读检查和真实预约尚未执行。** 官方网址并不携带已登录会话；Cloud 无法仅凭网址读取手机浏览器的 Cookie。应在已通过可信管理页面登录、保存了会话的数据目录所在机器运行。请勿把密码、Cookie、UID 或密钥发到聊天或提交到 Git。

## 运行前

- 使用本分支 P5 构建的二进制；P4 旧镜像没有此命令。
- 通过现有可信管理页面完成登录。iPad Safari / 安卓浏览器继续使用经过认证的 Tailscale HTTPS 地址或现有可信入口；官方页面登录不会自动同步到管理服务。
- 沿用原 `HDU_SNIPER_HOME` 和原 `HDU_SNIPER_SECRET_KEY`，不要重新生成密钥或复制新数据库来恢复次数。
- 保持 `HDU_STRICT_MODE=1`、`HDU_STRICT_WRITES=0`、`HDU_STRICT_VALIDATED=0`、`HDU_MANUAL_TEST_WRITES=0`。关闭每日自动预约、停止待命任务；真实提交前停止服务进程，防止其他进程或设备同时操作。发现生产 UNKNOWN 任务时先人工核验。
- 首次只读检查需用户授权使用保存的会话；测试提交还需馆方允许，以及用户确认具体日期、座位、时段。本阶段没有获得后者授权。

构建（Linux，无需启动容器或采购服务器）：

```bash
CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 cargo build --locked -p hdu-sniper-server
target/debug/hdu-sniper-server --manual-test --help
```

以下命令中的环境变量须已由运行机器安全配置，不要在命令行粘贴凭据。所有时间使用 **Asia/Shanghai**，`--start` 是整数小时，时长单位为小时。

## 1. 只读检查

```bash
target/debug/hdu-sniper-server --manual-test inspect
```

输出会话有效性、UID 核验布尔值（不输出 UID）、自习室允许时段/时长、已开放日期、已有预约记录数量。不会提交、锁座、签到或取消。

日期字段须来自实际 `range.advance_date / max_date`。当前仅能解释明确的 `YYYY-MM-DD` 起止日期；数字偏移、时间戳及其他未知结构均显示 `dateContractSupported=false`，拒绝提交。**仓库文档只证明这些字段存在，未证明其类型；模拟中的 ISO 日期不是生产契约验证结果。** 若实际格式不同，保留 `inspect` 的脱敏范围字段供适配和补测，不能用环境变量强行跳过验证。

## 2. 生成待确认方案（仍是只读）

从 `openDates` 选择一个未来时段，在本机替换下列占位符：

```bash
target/debug/hdu-sniper-server --manual-test prepare \
  --date '<已开放的YYYY-MM-DD>' --start '<开始小时>' --hours 1 --seat 162
```

可选座位仅 162 / 157。命令检查单人时长边界、时钟、四楼区域唯一性、两座位真实内部 ID、所选时段的空闲状态、已有预约冲突。修改日期仍会重新构造完整开始时间与时长。已占用、映射不明、会话失效或冲突均停止。

成功输出 `AWAITING_CONFIRMATION`、`preview`、有效期 5 分钟的 `ticket` 和完整 `confirmation` 文本。手机上核对日期、时段、1 小时时长、宋韵云图四楼、162 或 157 后，由用户明确确认；**到这里停止，不能自动执行下一步。** 过期只能重新只读 prepare，不会重置已用写入额度。

## 3. 仅在明确授权后单次提交

以下是供已获授权时使用的命令模板，本阶段不执行：

```bash
HDU_MANUAL_TEST_WRITES=1 target/debug/hdu-sniper-server --manual-test submit \
  --ticket '<prepare输出的ticket>' \
  --confirm '<prepare输出的完整confirmation>' --rules-allowed
target/debug/hdu-sniper-server --manual-test status
```

`--rules-allowed` 表示用户已核实馆方允许此用法，不代替馆方规则。提交前再次只读核对空闲、映射和冲突；ID 发生变化时须重新 prepare。随后先向 SQLite 写入不可重放意图，最多调用一次预约接口，再查询一次官方记录。日期、开始时间、座位、房间、时长全部吻合才报告 `SUCCESS`。

- 超时 / HTTP 404 / 成功响应但无匹配记录：核验后仍不明则 `UNKNOWN`，不重试、不切换座位。
- 明确占用、限流、认证失效、未开放或冲突：停止。没有自动取消功能。
- **每个账号整个 P5 验收最多一次写入**，包括被拒和结果不明；换票、换日期、换座位、重复启动都不会恢复额度。单次意图落库后进程中断，即使尚未发送，也保守保留 UNKNOWN。
- 独立 `manual_previews / manual_writes` 表，不创建或修改 `strict_tasks`。结果写入脱敏审计。没有删除/重置入口；保留原数据卷及密钥，不回滚数据库以恢复次数。
- `status` 只查看已保存的结果，不重新发送请求；UNKNOWN 后去官方页面人工核对，程序不会替你取消。

容器里使用同一数据卷和环境（必须先换成本分支 P5 镜像）：

```bash
cd deploy
docker compose stop hdu-sniper
docker compose run --rm --no-deps hdu-sniper \
  /usr/local/bin/hdu-sniper-server --manual-test inspect
```

将末尾 `inspect` 换成上述 `prepare` 参数即可。获得具体授权后，才可使用 `docker compose run --rm --no-deps -e HDU_MANUAL_TEST_WRITES=1 hdu-sniper /usr/local/bin/hdu-sniper-server --manual-test submit ...`。不要将门禁写进 `.env`。Podman Compose 可使用相同参数。退出后用 `docker compose up -d` 恢复管理页面，生产写入和每日预约保持关闭。

## 性能与结果边界

`timings` 由单调时钟记录登录检查、目录查询、ID 解析、冲突读取、本地写前处理、响应与记录核验。`http.localPrepareMs` 是签名/表单构造，`dispatchAt` 是客户端调用发送的墙钟时间，`dispatchToHeadersMs` 包含连接、网络、排队和服务端处理，`bodyDecodeMs` 包含响应体读取与解析。`requestUploadMs / serverProcessingMs` 为 null：现有客户端无法单独测得纯上传/纯服务端处理时间。

模拟耗时不是生产测量，普通时段实测也不代表 20:00 高峰表现。V3.1 仅在本次真实验收成功后再做。

复验命令：

```bash
cargo test --locked -p hdu-sniper-core -p hdu-sniper-auth -p hdu-sniper-hdu -p hdu-sniper-store -p hdu-sniper-server
cargo clippy -p hdu-sniper-core -p hdu-sniper-auth -p hdu-sniper-hdu -p hdu-sniper-store -p hdu-sniper-server --all-targets -- -D warnings
cargo fmt --all -- --check
```

实际执行结果、日志与构建标识见 [P5 验证记录](P5-VALIDATION.md)。
