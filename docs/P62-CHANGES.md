# P6.1.1 → Android P6.2 Lite

P6.2 分支从 `4313031b6c5059003314de482207ba539e1b06ca` 创建，主要对照 P6.0 `d144d479c6daeef61314ffe6e72beaf436560291`。调度改造位于原手机 `src/userscript/p60`，正式请求仍经 `signedRequest → BOOK_PATH → Transport.request`。构建依赖图仅含手机源文件。[P6.0](https://github.com/rrz0120-maker/HDU-Library-Sniper/tree/d144d479c6daeef61314ffe6e72beaf436560291) · [P6.1.1](https://github.com/rrz0120-maker/HDU-Library-Sniper/tree/4313031b6c5059003314de482207ba539e1b06ca)

## 手机时间线与归因

下表来自本次用户提供的真实运行时间线。源码可以验证执行路径，四晚原始完整日志没有作为附件提供。

| 日期 | 已提供的观察 | 改造依据 |
| --- | --- | --- |
| 11 月 18 日，P6.0 | POST 20:00:01.280，服务器成功 03.505，记录核验成功 05.360 | 服务器往返 2225 ms，随后核验 1855 ms。有效身份、座位、签名、正常预约 POST 和记录核验已在手机执行成功。 |
| 11 月 20 日，P6.1.1 | 时间门槛 00.729，POST 03.572，服务器成功 06.178，核验成功 07.916 | 门槛到 POST 2843 ms，HTTP 阶段 2606 ms，核验 1738 ms。核心协议继续成功，门槛之后仍有串行等待。 |
| 11 月 21 日 | 19:59:02.889 待命，19:59:40.399 停止，发送 0 次 | 原 entry 的隐藏、freeze、pagehide 会调用 suspend，stopSignal 会持久化停止。提供的时刻证明待命后 37510 ms 停止，具体首先触发的事件仍需原始日志确认。 |
| 11 月 22 日 | 门槛 01.313，查询 01.314–04.172，POST 04.189，06.420 返回 SEAT_UNAVAILABLE，官方无匹配 | 开放查询耗时 2858 ms，查询后到 POST 17 ms，HTTP 阶段 2231 ms。P6.2 删除此串行查询，采用独立的 +1350 ms 本地目标。提前提交能否得到该座位仍由当时馆方状态决定。 |

## 源码对照

| P6.1.1 路径 | P6.2 行为 |
| --- | --- |
| `p60/engine.js tick → 开放 GET → 开放证明 → submit` | `prepare → wait → submit`。已删除 OPEN_RANGE_CHECKING / NOT_YET / CONFIRMED、openProofGeneration、openingChecks、nextOpeningCheckMono，submit 与发出回调也没有开放证明条件。 |
| 保守 HTTP Date 门槛、两分钟准备有效期 | 预计算本地北京时间目标。远离目标每秒检查，5 秒内 100 ms，1.5 秒内 20 ms，余量更小时按余量等待。HTTP Date 保留传输兼容信息，P6.2 调度不使用它。 |
| 目录、日期范围、座位图、旧成功凭据、已有预约预检 | 准备阶段一次 baseInfo GET、一次类目 GET、一次范围 GET，校验身份及馆方当前允许时段。固定座位采用已有手机证据中的 1558 / 162 / 62726。准备阶段只有 GET。 |
| 固定 14 小时签名入口 | `signedRequest` 支持 1–15 小时整点时长，签名串格式、字段顺序、MD5→小写十六进制文本→Base64 算法及表单顺序保持相同。默认仍为 50400 秒。 |
| `Transport.request` 在回调前记 dispatchAt | 保留旧 pre-send 回调供原调用者使用。P6.2 的同步意图回调结束后，紧邻真实 fetch 调用采样 dispatchAt，再通知发送次数和 UI。读取 HTTP 错误的响应体，以区分 HTTP 状态、业务码和文案。 |
| 隐藏、freeze、pagehide → 永久停止位 | 页面事件仅影响当前等待的暂停和唤醒。真实当前时间决定何时提交，超窗记录实际延迟。用户「停止待命」取消零发送任务，下一次点击可重新授权。 |
| 旧账本、账户每日任务、历史 STOPPED、核验次数预算 | 使用独立 p62 命名空间。日志读取失败不会阻止新准备。只对已有未决或已受理的重叠时段避免重复写入，官方记录核验可主动继续。 |
| 请求发送、服务器回执、记录核验混合反馈 | 分别展示 SENDING、ACCEPTED、SUCCESS、FAILED、UNKNOWN，以及 HTTP 状态、业务码、是否受理、核验结果、真实发送次数和超窗标记。 |

座位 ID 引用 `p53/policy.js TASK`，使用同文件 `resolve162` 的官方座位图结构夹具核对。日期规则沿用手机 `dailyTask` 和上游自习室 +2 日规则。记录核验继续使用 `records`、`verified162` 及同一个官方列表端点。[上游时间规则](https://github.com/AlaIchhe/HDU-Library-Sniper/blob/f1055c9713c7b5917c4ef4d6d1c959864e41f05c/internal/core/time.go) · [上游预约接口](https://github.com/AlaIchhe/HDU-Library-Sniper/blob/f1055c9713c7b5917c4ef4d6d1c959864e41f05c/internal/hdu/booking.go) · [上游签名](https://github.com/AlaIchhe/HDU-Library-Sniper/blob/f1055c9713c7b5917c4ef4d6d1c959864e41f05c/internal/hdu/crypto.go)

## 保留保护的理由与开销

| 保护 | 必要性 | 执行位置及影响 |
| --- | --- | --- |
| 身份、时段及参数校验 | 避免以失效身份或无效时段提交 | 准备阶段完成。出现错误时允许修正后再启动。 |
| 账号 Web Lock | 两个标签页同时启动可能各发一笔 | 准备阶段取得并持有，第二个标签页立即显示冲突。整点不用等待锁。 |
| 同步未决请求意图 | 刷新或进程消失后需要识别可能已发出的申请 | 提交前同步读当前标记，签名后仅同步写一份小型意图。发出后才保存完整脱敏回执。崩溃边界不能确定是否发出时，次数显示 null。 |
| 最小 10 秒间隔及馆方限流期 | 明确失败也消耗写入额度，密集 POST 可封禁 | 仅本地比较已知上次写入和限流截止。没有自动重试队列。10 秒不足以保证限流桶还有额度。 |
| 同日任务有效性 | 冻结到次日后，旧的后天目标可能已不符合用户当天选择 | 同日恢复可迟发并如实标记。跨日恢复显示零发送，需要核对日期重新启动。 |
| 已知旧手机入口互斥 | 同一页面启用两个脚本会重复启动 | P6.2 先运行时占用旧入口已检查的宿主 ID；旧版先运行时本页 P6.2 显示冲突。官网 fetch 与按钮仍使用原调用。已打开的其他旧标签页须在迁移时关闭。 |
| 未知结果保持未决 | 超时、断网和 404 无法证明服务器没有受理 | 支持主动查官方记录。成功只读核验，明确失败结束本次写入。 |

这些限制均针对具体请求或已知馆方节流信息。零发送的准备失败、主动停止以及历史 STOPPED 都不会占用新的请求额度。

已实际读取上游 `docs/HUITU-LIMITS.md`，其中 3 秒和 5 秒曾触发封禁，10 秒在额度已经耗尽时也会封禁。写入失败同样计入额度，预锁和提交前重查座位图均非预约前提。P6.2 每个任务只发送一次正式 POST。[限流原始报告](https://github.com/AlaIchhe/HDU-Library-Sniper/blob/f1055c9713c7b5917c4ef4d6d1c959864e41f05c/docs/HUITU-LIMITS.md)

P6.0、P6.1、P6.1.1 的安装文件保留原始 SHA-256。其旧构建命令从固定手机提交恢复对应原文件，避免新 p60 源码被误打包成旧版本名称。[校验清单](../userscripts/SHA256SUMS)
