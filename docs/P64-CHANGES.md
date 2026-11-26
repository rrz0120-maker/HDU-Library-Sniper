# Android P6.4 Lite 候选变更说明

P6.4 基于 P6.3 固定提交 dccafec5d02993cb31e85f9d19bee6e9e461ee7f。
本轮仅本地开发、构建和离线验收。实际模型及推理配置登记 NOT_EXPOSED。
研究依据为本会话已保存的 01、02、03、05 成果及用户冻结结论。
研究中手机高峰 4/8 已发送成功的样本不足以推断版本因果或预测本次修复的成功率收益。

## 最小修改与实际调用链

P6.4 entry → DailyEngine.prepare → wait → submit → Transport.request。
传输返回后，由 p60/policy.js 的 bookingResult 分类，engine.emit 更新状态，
DailyStore.receipt 保存未决保护，publicDiagnostics 生成脱敏回执，panel 显示结果。
仅 SERVER_SUCCESS 会沿用原来的自动官方列表核验。verify 用原 verified162 匹配完整目标。

误分类来自共享 responseCode 对“无法预约”的宽泛匹配，手机 bookingResult 原先直接采纳。
本次在手机业务判定层要求明确座位措辞，并单列时间范围错误。共享 core.js 及其他端的调用者保持其旧语义。
传输层仅追加 invalidJson 观察标记，旧调用者继续获得原先的 null 或错误。
非法 JSON 在 P6.4 显示 INVALID_RESPONSE，未决状态继续保护请求。

| 输入或证据 | P6.3 | P6.4 |
|---|---|---|
| 11/25 原句“选择的座位无法预约，可能座位不可用或已经被其他人锁定或占用。” | SEAT_UNAVAILABLE | SEAT_UNAVAILABLE |
| ParamError，泛称“该账户无法预约” | SEAT_UNAVAILABLE | BUSINESS_REJECTED |
| “该账户无法预约座位，账户已被锁定” | SEAT_UNAVAILABLE | BUSINESS_REJECTED，账户锁定不等于座位占用 |
| “座位状态说明：占用信息暂不可用” | SEAT_UNAVAILABLE | RESPONSE_UNKNOWN，不凭分离关键词认定拒绝 |
| ParamError，“参数错误” | BUSINESS_REJECTED | BUSINESS_REJECTED |
| ParamError，“未到开放时间”或“预约时间尚未开放” | NOT_OPEN | NOT_OPEN |
| “超出可预约座位时间范围” | NOT_OPEN | TIME_RANGE_INVALID |
| ParamError，只有陌生文案或没有文案及 result | BUSINESS_REJECTED | RESPONSE_UNKNOWN，保留未决 |
| 明确 result=fail 且无更具体类别 | BUSINESS_REJECTED | BUSINESS_REJECTED，仅确认拒绝 |
| 已有预约 | EXISTING | EXISTING |
| 鉴权 HTTP 401、重定向、is_login=false | AUTH_REQUIRED | AUTH_REQUIRED |
| 明确业务 AUTH_REQUIRED、ParamError 登录失效原句 | 未明确分类 | AUTH_REQUIRED |
| 明确限流、HTTP 429 | LIMITED | LIMITED |
| HTTP 404，含座位文案或非法 JSON | HTTP_404 | HTTP_404，保持 UNKNOWN |
| 其他非 2xx | HTTP_ERROR（原实现从400起） | HTTP_ERROR |
| 200 非法 JSON | RESPONSE_UNKNOWN | INVALID_RESPONSE |
| HTTP 200 / 只有 ok / 只有 success | RESPONSE_UNKNOWN | RESPONSE_UNKNOWN |
| 网络异常 / 超时 | NETWORK_ERROR / TIMEOUT | 同类 UNKNOWN，保留意图 |
| 业务 ok 且 result=success | ACCEPTED | ACCEPTED，显示“已受理，尚未核验成功” |
| 官方记录完整匹配 | SUCCESS | SUCCESS，显示“预约成功且记录已核验” |

保留已有枚举 EXISTING、AUTH_REQUIRED、LIMITED、ACCEPTED、SUCCESS、RESPONSE_UNKNOWN，
分别承载已有预约、鉴权失效、限流、受理待核验、核验成功和无法判定的语义。
FAILED 显示“业务明确拒绝”，SENDING 显示“已发出，等待回执”。
已有保护依赖的状态枚举继续适用；受理、已核验与未知分别显示。

## 机制对照

| 机制 | P6.3 | P6.4 |
|---|---|---|
| 默认计划 | 北京时间20点后1350ms，设备墙钟 | 相同 |
| 准备 | 身份、目录、范围三次 GET | 相同 |
| 提交 | 账号 Web Lock、同步意图、一次正式 POST | 相同 |
| 受理后 | 自动一次官方记录 GET | 相同 |
| UNKNOWN | 未决保留，主动只读核验 | 包括新增 INVALID_RESPONSE 和不明 ParamError |
| 历史档案 | hdu-p63:history，最多30条 | hdu-p64:history 最多30条，加只读显示原P6.3历史 |
| 请求意图与限流 | hdu-p62 账号键及 Web Lock | 共用原键，跨版保护继续生效 |
| 诊断版本 | 导出时强写当前 VERSION | 保留原6.2/6.3版本，新任务标6.4.0，未知为null |
| 分类器版本 | 无 | 每个新任务记录p64.1，旧日志为null |
| 布尔证据 | 未记录也可能导出false | 缺失为null，旧日志中已有false逐值保留 |

## 证据与兼容

保留 httpStatus、businessCode、businessResult、failureMessage、reason 和 verification。
missingFields 对这些回执字段给出 ABSENT、REDACTED、INVALID_RESPONSE、NOT_OBSERVED、
NOT_APPLICABLE 或 LEGACY_NOT_RECORDED。null 表示未声明该字段缺失。
HTTP 尚未观察为 NOT_OBSERVED，旧字段缺失使用 LEGACY_NOT_RECORDED。
REDACTED 也包括白名单不认识的业务码、result 和原句。
成功没有失败文案，记 NOT_APPLICABLE。其他阶段时间字段仍按原约定用 null 表示未取得。

failureMessage 只取原回执中实际出现的白名单短句。任意原文只存在本页内存，
受控 CODE 白名单之外导出 OTHER，未知 result 导出 null。
Cookie、token、姓名和任意错误全文都不新增到导出。
客户端 REASONS 提示与馆方片段分别产生，客户端提示不填入 failureMessage。

旧 JSON 恢复只做脱敏和已有任务结构校验，原 reason 不重新分类。
原P6.3历史键完全只读，恢复后再核验的快照保存至新归档，原档案继续可见。
两个归档可能显示同一 runId 的两个版本快照，比较时应按 runId 识别同一次请求。
请求意图账本仍需随真实核验更新，它承担当前去重职责。
构建 P6.3 命令按固定提交恢复冻结文件，避免当前6.4代码被打包成6.3名称。

## 构建与回滚

运行 npm run build:userscript:p64 构建候选。
候选文件为 userscripts/HDU_Android_P6.4_Lite.user.js。
没有新增项目依赖，沿用 Vite 构建。
只有 build:userscript:p63 的冻结恢复命令需要基线 Git 历史；包内也直接提供原P6.3文件。

回滚时先导出P6.4诊断与历史，停用候选，再使用包内冻结的P6.3文件。
保留站点数据、原账号意图、限流截止与两版历史，确认只启用一个版本。
P6.3可读取同一意图中的 UNKNOWN/ACCEPTED/SUCCESS 并阻止重叠写入。
旧UI不认识新 reason 时可能显示 LOCAL_ERROR，但 UNKNOWN 意图仍受保护。
核验真实结果只通过官方记录，不以清站点数据或自动重试消除未决。

馆方脚本写入许可未核实。实际使用限定为官方入口人工正常预约，候选保持离线。
一加 Firefox + Tampermonkey 安装、休眠与恢复均为 REAL_DEVICE_UNVERIFIED。
