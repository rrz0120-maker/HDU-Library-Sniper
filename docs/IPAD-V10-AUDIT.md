# iPad V10.0 Lite 可靠性审计

V9 基线为 `cafeb1c3764765e2feff948ebc62641e4e693b49`，原 ZIP 固定于 `bcaec606305bf122d64399f34db520f0beb38241`。本分支直接继承 V9。Android 对照为 P6.2 `e895b99`、P6.3 安装提交 `ca456d8` 和报告提交 `dccafec`。已核对仓库根 AGENTS.md、原安装文件和相关分支。[V9 协议追溯](IPAD-V9-TRACE.md) · [V9 验证](IPAD-V9-TESTS.md) · [P6.3 诊断设计](https://github.com/rrz0120-maker/HDU-Library-Sniper/blob/dccafec5d02993cb31e85f9d19bee6e9e461ee7f/docs/P63-ANDROID-LITE.md) · [P6.3 同浏览器对照样本](https://github.com/rrz0120-maker/HDU-Library-Sniper/blob/dccafec5d02993cb31e85f9d19bee6e9e461ee7f/docs/evidence/p63/timing.json)

## 实战记录的边界

按用户提供的 Android P6.2 日志摘要，11 月 23 日偏移 1350 ms，20:00:01.355 调用 fetch，20:00:03.029 进入浏览器请求阶段，相差 1674 ms。20:00:05.776 观察到响应，httpMs 为 4421，官方记录匹配。11 月 24 日偏移相同，01.362 发出，01.434 进入请求阶段，01.481 观察到响应；日志记 httpMs 为 120。只发一次，等待中未隐藏。HTTP 200、业务 ParamError / NOT_OPEN。两次调度误差分别为 5 和 12 ms。两次日志都没有给出馆方收到数据包或正式开放的精确时刻。

11 月 24 日 iPad 缺少导出的运行编号、收发时间、原始回执及官方记录。可确认的是用户看到近似座位不可用的提示、刷新后看到 IDLE。原始终态及原因均为 NO_EVIDENCE。事后手机校时测得快约 500–600 ms，当晚误差和请求间设备干扰均无同步证据。保留 1200 ms 本地偏移，由用户按系统设置校时。P6.3 的桌面 Firefox 数据仅用作架构和测试方法参考。

## 逐段核查

| 链路 | 结果 | 可检查的结论 |
|---|---|---|
| 1. 元数据与加载 | PASS | HTTPS 精确主机匹配、顶层页面、document-end、grant none、无远程脚本。原生 DOM 面板有版本号。真实加载 V9/V10 两种顺序，有且仅有一方能启动。 |
| 2. Userscripts 上下文 | REAL_DEVICE_PENDING | 延用 page 注入和同源原生 fetch。桌面测试加载同一个 IIFE，检查 Shadow DOM、原生官网按钮和 Cookie。真实扩展权限、隔离世界、CSP 和版本组合需设备验证。 |
| 3. 登录和凭据 | PASS | 基线 GET baseInfo 无 LAB_JSON，检查 is_login 与数字身份，同源发送浏览器会话。TLS 模拟器验证 HttpOnly Cookie、签名头、座位和表单。 |
| 4. 参数和映射 | PASS | 仍调用 V9 makeTask 及已验证的固定 ID 62726、楼层 1558。整点时段为 07–22 内的合法区间。准备时不查询座位图。V9 清单和上游 Go 签名独立比对验证字段。 |
| 5. 时间与日期 | PASS | 明确上海时区、当晚开放后天，跨月跨年和立即模式开放界线有用例。记录墙钟与单调时钟增量差。未引入时钟补偿。 |
| 6. 定时与有效期 | PASS | 保留原单一本地定时器、用户可见日期复核和发前同步意图。恢复若已跨北京自然日，零发送结束。同日迟到显示实际延迟。 |
| 7. 页面生命周期 | PASS / REAL_DEVICE_PENDING | 两种桌面引擎通过隐藏、恢复、刷新和迟到用例。WebKit 模拟 freeze/resume、前后墙钟跳变。iPadOS 的真实锁屏、BFCache、进程回收及休眠仅能实机确认。 |
| 8. 正式请求 | PASS | 直接复用 bookSeatRequest 生成即时签名和六字段 POST，补交也走同一实现。整个整点路径只有一个原生 fetch。 |
| 9. 高峰传输 | PASS | 原有读 5 秒 / 写 30 秒 deadline 贯穿响应体消费。区分读 404、读超时、写超时、断网、HTTP 异常、格式不完整。计时 API 缺失时保留 null。 |
| 10. 业务解释 | PASS | CODE=ok 且 DATA.result=success 方记受理。404 保留未决保护；过频、认证、未开放、已有预约及明确座位拒绝各有对应状态。未知回执仅供核验。 |
| 11. 官方核验 | PASS | 依次核对有效状态、开始秒、时长、房间及座号和可用 ID。首次匹配时间与最近一次核验分开。已匹配后若读取异常仍保留既有事实，明确查无记录时更新当前匹配状态。 |
| 12. 持久化与去重 | PASS | 跨版本共用原账号 Web Lock 及同步未决意图，存储不可写时给出原因。每个 runId 独立保存脱敏归档，清除历史不释放未决或限流保护。 |

## 发现、证据与修复

| 分级 | V9 证据 | V10 处理 |
|---|---|---|
| CONFIRMED_DEFECT | 模拟座位拒绝后，同一标签正常刷新能恢复。关闭标签、同源新开则导出 IDLE。V9 的失败原文只在内存，终态主要在 sessionStorage。 | localStorage 独立留存 30 条脱敏运行，当前页和上次/历史明确标示，支持复制。归档异常提供可见反馈。 |
| CONFIRMED_DEFECT | 实际加载 V9，HTTP 404 / NotFound 导致 failed，核验按钮禁用，明确失败分支删除请求行。带冲突座位文案的 404 还可能被归为占用。 | 对普通 404 保留 HTTP 和业务字段，结果待核实，未决去重照常生效。明确限流仍然停写。 |
| CONFIRMED_DEFECT | V9 对 ParamError「该账户无法预约」的分类为 SEAT_UNAVAILABLE。 | 只有消息包含座位证据才归入该类，其他明确参数拒绝记为业务拒绝。未知码及未知回执保留待核实。 |
| CONFIRMED_DEFECT | V9 在已有 matched 后再次查记录失败，checkRecord 会把 verified 降为 accepted，与仍保留的 verifiedAt 冲突。 | 读取错误记在 verification，保留先前记录匹配；最新明确 absent 单独更新。 |
| CONFIRMED_DEFECT | V9 未决键仅比较完全相同的日期、开始和结束；变动开始小时即可避开同一重叠申请的保护。 | 在现有账户锁内检查重叠且仍有效的记录，不增加准备 GET。原订单在官网取消后，可按原时段只读核验。 |
| VERIFIED_DIFFERENCE | 同一 WebKit 会话中 sessionStorage 的同标签刷新恢复与新标签页恢复有不同结果；与 V9 的依赖直接相关。 | 按来源选择标签页快照、请求意图和本地历史，各自承担不同用途。 |
| SUSPECTED_RISK | Safari 存储配额、隐私模式、系统休眠、网页丢弃及后台锁的实际行为随环境而变。 | 模拟拒写、Web Locks 缺失或拒绝、Resource Timing 缺失，均有明确结果；各类系统条件的发生概率未知。 |
| NO_EVIDENCE | V9 当晚真实失败的业务码、时间、设备间干扰、手机当晚钟差，均缺少逐请求证据。 | 保留证据缺口；未从模拟推断实战根因或最佳发出时间。 |

[原版故障复现](../tests/userscript-v10/baseline.py) · [WebKit 专项回归](../tests/userscript-v10/audit.py) · [独立断言](../tests/userscript-v10/audit.test.mjs)

## 架构取舍与诊断口径

与 P6.3 相同，每次启动有 UUID；请求保护、上次显示和历史归档分开。当前页可展示业务原文，历史及复制结果只允许固定字段、受控业务码、已知消息短句。未知原文只留在当前页面内存。P6.3 用历史数组和额外归档锁；V10 每次运行有独立本地键，保存时只更新相应记录。清理历史不会清理原 V9 账户保护。读取历史和复制 JSON 都不获取登录、记录或座位数据。点击核验属于单独授权的读取操作。

iPad 保留 V9 的前台等待、立即预约模式、09–22 和 +1200 ms。普通首次准备只有身份 GET；P6.3 的 Android 准备期有三个 GET。沿用 V9 的 10 秒写间隔和至少 600 秒限流期，尊重更长的 Retry-After。明确 NOT_OPEN 后，只有用户选择原有立即模式、间隔满足且原有开放检查通过，才可启动一次人工补交。刷新、查看历史、失败回执均不会发起自动续写。

dispatchAt 取自签名、同步意图完成后的 fetch 调用点。scheduleLagMs 对照 plannedAt；delayFrom20Ms 对照北京 20:00。requestStartAt 需要唯一可归属的 Resource Timing 条目。responseWaitMs 是 requestStart 至 responseStart，responseDownloadMs 是 responseStart 至 responseEnd。responseAt/httpMs 是脚本观察到响应头的墙钟及单调耗时；businessAt 对应 JSON 解析完成。超时、连接失败、浏览器不提供的阶段都保留可辨认的空值。保护意图已经落盘而 fetch 是否交出无法证实时，attempts 为 null。浏览器字段不能测量馆方实际收包时间。

上游 Issue #4 的初始记录显示 404 与退避并存。开发者后续回复及限流报告将实验中的 404 定位为应用并发保护，报告亦记有高峰时写端点 404。业务拒绝消耗写额度，10 秒也不能保证有余额。上游相关提交包括修正预锁座位传递、实测节拍和核验返回的座位。本版吸收协议和回执证据，采用单次写入约束。[Issue #4 及开发者回复](https://github.com/AlaIchhe/HDU-Library-Sniper/issues/4) · [限流实测](https://github.com/AlaIchhe/HDU-Library-Sniper/blob/f1055c9713c7b5917c4ef4d6d1c959864e41f05c/docs/HUITU-LIMITS.md) · [8b2cd6c](https://github.com/AlaIchhe/HDU-Library-Sniper/commit/8b2cd6c) · [bf319d4](https://github.com/AlaIchhe/HDU-Library-Sniper/commit/bf319d4) · [f39b9c2](https://github.com/AlaIchhe/HDU-Library-Sniper/commit/f39b9c2)

开发期另有一个已复现的跨标签竞态。旧标签持有先前的未决快照，其他标签已匹配官方记录。旧标签随后在核验登录阶段失败时，若把旧快照再写入同一 runId，就会覆盖已匹配的历史。V10 将这种未取得权威请求行的错误留在该标签的显示快照，正式归档保留已匹配回执。独立状态测试和双标签 HTTPS 场景均针对这一顺序设置断言。
