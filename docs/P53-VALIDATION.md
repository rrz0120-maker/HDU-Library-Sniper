# P5.3 验证记录

基线：`feat/android-p51-userscript` / `a146d28fc38299325387e560714959ae382763a4`。开发分支：`feat/android-p53-2000-single`。版本：5.3.0。开发环境：Codex Cloud。本会话无法核验或切换底层模型名称、推理档位，**不声称启用了 GPT-6 Astra Max**。

## 实现与依据

| 部分 | 实现及证据 |
|---|---|
| 唯一目标与日期 | `src/userscript/p53/policy.js` 固定 11-17 20:00 → 11-19 08:00–22:00、50400 秒、1558/62726/162；`crates/core/src/time.rs` 的自习室 +2 与 20:00 调度，以及用户本次指定规则。 |
| 日期接口 | 复用 P5.2 秒级安全整数、上海零点、异常跨度拒绝和 `max_date` 排他上界；[官网控件原始证据](evidence/p52/date-control.json)。当次范围本身不能独立证明服务端写入开放时点，因此正式勾选还要求用户确认馆方规则。 |
| 签名和同源请求 | `core.signedRequest` 增加受限 duration 参数，旧四参数调用仍为 3600；新版本传入 50400。复用 `Transport`，仅增加可选响应头/发出时刻钩子和响应时间，不改旧客户端默认流程。 |
| 防重复 | 独立 IndexedDB，原子意图先于唯一写入；同账号 P5.2 已消费成功记录是跨版本保护条件；只读、不修改旧库。 |
| 响应核验 | 复用既有错误分类，14 小时重叠/精确记录核对；404、超时、未知响应保持 UNKNOWN，最多一次自动查询。 |
| 安全停止 | 前后台切换、刷新、用户停止、过时、校时失效停止；没有备用座位、预锁、自动签到、取消或写重试。 |

按要求定点读取了原作者四个 Go 文件的最近相关提交，没有重新分析整个项目。Go 源码已从当前 Rust 树移出，因此通过 GitHub 路径历史读取；精确引用见 [来源清单](evidence/p53/sources.json)：

- `internal/hdu/booking.go`：Unix 秒、`durationHours * 3600`、新鲜 `api_time`、`Api-Token` 与表单字段。
- `internal/booking/classify.go`：座位目录 ID 映射、消息读取、明确不可用、限流及超时/404 区分。
- `internal/booking/executor.go`：超时后查记录，未找到也不能认定失败；已有记录防重复。其多座位、预锁、循环和重试不属于本任务。
- `internal/scheduler/scheduler.go`：上海时区开放时点与可取消等待。原项目还包含自动签到等功能，本版未调用。
- `docs/HUITU-LIMITS.md`：高峰 404 与写结果不明、读写超时差异、写入限流。本版只有一次写入，不采用该文档其他模式的轮询或预锁。

Go 测试中的 `ApiToken` 函数逐字来自原项目 `internal/hdu/crypto.go@30d2a1937ff183a7f236e1b347ae7cddb1a21560`。同一组 3 条合成账号向量由 JavaScript、原 Go 函数、现有 Rust `api_token` 分别验证；不使用真实 UID。当前真实座位 ID 是用户提供的公共映射，运行时仍核验。

## 可复验测试

最终结果、版本、哈希见 [机器可读报告](evidence/p53/results.json)，完整逐项输出保存在同目录。所有浏览器网络经 Playwright `context.route("**/*")` 拦截；未知端点直接失败，未向馆方提交测试请求。浏览器测试使用桌面 Firefox/Chromium 的手机尺寸、触摸与 Android UA，**不等于 Android Firefox + Tampermonkey 真机测试**。

```bash
# 安装项目已有依赖后，在仓库根目录运行；手机安装不需要这些工具。
node scripts/build-userscript-p53.mjs
node --test tests/userscript/*.test.mjs tests/userscript-p53/*.test.mjs
npx playwright test --config playwright.p53.config.ts
npx playwright test --config playwright.userscript.config.ts
cargo test --locked -p hdu-sniper-hdu userscript_vectors --lib
go test -v tests/userscript-p53/signature_go_test.go
npx tsc --noEmit
npx biome check src/userscript/core.js src/userscript/transport.js src/userscript/p53 \
  tests/userscript-p53 tests/fixtures/p53-signatures.json \
  scripts/build-userscript-p53.mjs playwright.p53.config.ts package.json
node --check userscripts/hdu-p53-2000-single.user.js
cd userscripts
sha256sum -c SHA256SUMS
```

不要运行旧版构建器去覆盖已交付的 P5.2 文件；新构建器只生成独立 P5.3 文件。

## 用户要求的 22 项场景

| 场景 | 覆盖位置 |
|---|---|
| 1–4：19:59:59、合法开放门禁、20:00 后一次触发、计时器延迟 | 核心时钟测试；浏览器整点流程；超 10 秒停止。秒级 Date 保守下界过线后才发，不把精确 20:00:00.000 描述为可保证。 |
| 5–8：162 映射、日期、排他上界、14 小时签名 | 核心规则测试、浏览器请求断言、Go/Rust 共用签名向量。 |
| 9–15：成功、占用、未开放、404、超时、限流、记录延迟 | 核心响应矩阵及浏览器 Mock；真实 Transport 超时、没有第二次 POST。 |
| 16：已有记录 | 14 小时内（包括 21:00）的冲突阻止写入。 |
| 17–18：刷新、双标签页 | 真实 IndexedDB 原子事务、双实例竞争、恢复 WAITING/UNKNOWN 不提交。 |
| 19–20：前后台切换、中途停止 | 合成 visibility 事件、跨标签页停止、意图提交与 fetch 之间停止、请求中中止。 |
| 21–22：未知不重发、任意失败最多一次 | 每种异常后再点击/再 tick/刷新检查计数，独立浏览器配置完整关闭重开后 UNKNOWN 仍消耗预算。 |

额外检查：默认收起与窄屏无横向溢出、同源 HttpOnly 模拟会话、日志脱敏、P5.2 并存预算、历史内容逐字段不变、缺少 P5.2 成功凭据/存储/身份/映射时零写入、只读核验预算持久化。

## 实测边界与过程记录

- 本轮只完成离线开发、构建和模拟检查；**没有部署云服务，也没有使用真实校园凭据、预约、取消或签到**。
- P5.2 真机 157 一小时成功为用户反馈。P5.3 手机安装注入、只读待命演练、14 小时限制最终受理及整点拥堵均未由本环境验证。
- Mock 耗时不代表手机、服务器或 20:00 的真实性能。HTTP Date 也不提供精确毫秒校时；详见[使用说明](P53-ANDROID-SINGLE.md)。
- 首轮浏览器 32/34 通过：两项 404 测试过早把“请求中 UNKNOWN”当作请求已完成，修正为等待发包计数和核验完成。第二轮 35/36 通过：Firefox 完整关闭会触发额外停止标记，恢复用例调整为验证两种正确止损原因及零重发。一次环境切换中断了后续运行，最终从头复验，未把中断当通过。
- 首次 Rust 命令误用包名 `hdu`，未执行测试；改为仓库真实包 `hdu-sniper-hdu`。系统 `/usr/bin/go` 不是 Go 语言工具链，使用从 go.dev 获取并校验官方 SHA256 的临时 Go 工具链；首次向量路径不适配 Go 测试工作目录，改为源文件相对路径后复验。失败日志保留在 `/workspace/HDU-v3-verification/`。
- 原 P5.2 文件 SHA256：`48b28459cca2952a659ab0e740cf97e7d82a64866e7c16111a552e31e3cf3c5f`。原分支与历史提交不改写。新版本的共享签名扩展不改变 P5.2 默认一小时调用；其现有测试重新通过。

下一步只做[手机只读演练](P53-ANDROID-SINGLE.md#先做手机只读待命演练)，由用户核对后在当日明确勾选启用。本轮不开发 161/157 回退、多日期或其他后续扩展。
