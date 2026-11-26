# P6.4 离线验收

状态：RELEASE_CANDIDATE，仅表示离线候选验收通过，不表示正式发布或获得馆方写入许可。
所有回执、时钟、设备行为测试均为 SIMULATED。

最终Node测试120/120通过。Chromium 156.0.8078.79与Firefox 153.0各45组通过：
28组P6.3/P6.4配对回执、15组原保护回归、归档存储故障组、跨版加载及回滚组。
每个浏览器56条版本样本的初始网络动作逐组完全一致，每个用例只有一次有效POST。
未知、受理和成功状态的刷新/重复点击检查均未产生第二次POST。
语法检查、代码差异空白检查、重复构建哈希与冻结P6.3恢复哈希通过。

候选文件SHA-256：`ac9ec4b333528c66fed4fdd17ebd0ec670b171e0818a85d87a32214a7ac1e3e6`。
机器可读清单与逐项验收门槛在 `docs/evidence/p64/build.json`。
已通过：误分类修复、新增测试、原核心回归、无新增请求、重复写保护、未决保护、
历史兼容、核心时序不变及离线回滚。真机等未验证事项列于下文。

## 基线与冻结

基线提交 dccafec5d02993cb31e85f9d19bee6e9e461ee7f。
远端 feat/android-p63-lite-diagnostics 经只读核对仍为该提交。
P6.3 安装文件 SHA-256 为 5dfafed08e624d4acab18700b71c5346d1cc752682a25636a5f4c0d0db1b86a0。
独立分支 candidate/android-p64 由该提交建立，开始时工作树干净。
研究缓存仓库有未检出的文件状态，原样保留；开发在独立克隆内完成。
没有修改远端分支。

修改前100项Node回归通过，P6.3原安装包通过19组Chromium浏览器检查。
新增12项分类测试先在未修改实现上执行，7项通过、5项失败。
失败包括账户误分类、范围误分类、未知文案、空ParamError和业务鉴权码。
对应日志在 docs/evidence/p64。
维护者复查又用账户锁定与中性座位说明两条反例证明初稿的座位关键词跨度过宽，
先记录2项失败，再收窄为明确座位短语；占用正例同时保留。
这次复查的失败证据单独保存于 maintainer-before-fix.log。

## 验证口径

Node 最终覆盖旧核心、时段/日期、存储、单次请求、传输、Resource Timing 及本次分类与历史兼容。
P6.3原有“范围错误属于NOT_OPEN”的一项预期按明确需求改为TIME_RANGE_INVALID，其余原测试保持原断言。

tests/userscript-p64/browser.py 复用原本地 TLS Mock。
代理终止模拟域名并拒绝转发，测试无需真实馆方连接。
在同一浏览器内依次加载已冻结的P6.3与最终P6.4安装文件。
每组验证起始网络动作序列完全一致、唯一POST的表单/签名校验有效。
已知回执读取还核对状态、展示、意图账本和缺失原因。
UNKNOWN/ACCEPTED/SUCCESS 再刷新、重复点击时断言仍只有一次POST。
详细动作以 chromium-network.json / firefox-network.json 保存。

| 覆盖 | 断言及用例 |
|---|---|
| 真实11/25句子、账户、参数、开放、范围、已有、限流、鉴权、404 | paired矩阵核对reason、state、UI、账本、自动读取序列 |
| 200缺字段、陌生文案、未知码、非法JSON、合法null | 未知保护，脱敏，缺失原因，刷新后无第二写 |
| 断网、超时、503 | UNKNOWN及原意图保护 |
| 受理后查无记录或读取失败 | ACCEPTED、一次自动核验、待核实、无重试 |
| 官方完整匹配 | SUCCESS、recordVerified、日期/时段/座位匹配 |
| 页面生命周期与发出后刷新 | 继承visibility_and_restart、suspended_late、refresh_after_send |
| 重复点击、同账号多标签 | 每组待命重复点击及two_tabs，活动账号锁 |
| 发出边界中断 | crash_intent中未知次数和PENDING恢复 |
| 诊断或回执存储失败 | optional_diagnostics、history_storage，保留意图并提示 |
| 旧JSON与30条上限 | Node逐值核对旧版本/原分类，旧键字节完全保留，新键30条 |
| 原共享调用者 | 原Node回归及legacy HTTP处理，原安装文件哈希固定 |
| P6.3与P6.4同时加载、候选回滚 | 两种加载顺序均只有一个面板及一次POST；P6.4未知回执后加载P6.3仍保留未决，候选历史原字节不变 |

候选原套浏览器回归沿用15个未改变语义的测试函数。
原replies、uncertain的内容由新配对矩阵及刷新保护覆盖，因为新版本明确改变其中两项语义。
本轮增加history_storage，覆盖旧档案只读与新归档/回执写盘故障。
mixed_versions 增加两种跨版加载顺序和一次真实旧安装包回滚模拟。

## P1诊断审计

用户点击后进入prepareStartedAt，字段表示引擎准备开始，无法声称精确等于点击授权时刻。
preparedAt、plannedAt、dispatchAt、requestStartAt、responseAt、businessAt、verifiedAt、
storageStatus已分别提供准备、计划、fetch、浏览器请求阶段、HTTP头、业务处理观察、首次匹配与归档状态。
clockChangeMs只表示运行中墙钟与单调钟增量差。
浏览器计时缺失继续用null，馆方接收及处理时刻UNKNOWN。
本轮只有非法JSON的既有解析分支增加观察标记，未增加计时来源、网络或采样流程。
没有严重证据缺口要求改造调度。精确授权时刻、RT缺失原因细分留作后续需求。

## 维护者复查与限制

复查范围为与基线的源代码差异、构建产物和可达调用路径。
共享core、签名、日期计划、偏移、准备读取、wait及单次写入路径无策略修改。
新增分类沿用已有状态，陌生文案在缺少明确失败信号时保留UNKNOWN。
JSON、历史导出与分类版本避免把新解释追写为旧回执事实。
新归档只读旧键，共用原账号锁和意图键，避免两个版本分别建立写额度。
回滚可能出现旧界面不认识新reason的显示限制，待核验状态仍保留。
分类器是受证据约束的短语规则，不声称理解所有馆方未来文案；陌生文案没有明确失败信号时保留未知。

全站React/Vitest、Rust、iPad功能不在本次修改范围，本轮未重跑。
桌面Firefox和Chromium不覆盖一加手机系统调度、Tampermonkey上下文、移动网络和进程回收。
这些项目均登记REAL_DEVICE_UNVERIFIED，真实竞争结果亦未测。
没有据此声称实际预约成功率提升。

## 后续验证

先审查diff、候选哈希、分类对照及未决测试证据。
在获准范围内使用独立离线页面核对手机显示、复制诊断及历史恢复。
真实预约仅经官方入口人工完成正常学习需求，保留当日官方结果。
若发现重复写或未决保护失效，停用候选并保留日志及意图，再按变更说明回滚。

## 复现命令

本次环境：Node 24.22.3、Python 3.12.14、Python Playwright 1.62.0、Vite 7.3.6、Biome 2.6.5。
Vite与Biome安装于独立工具目录并以未跟踪node_modules链接使用，未变更项目依赖或锁文件。
以下从包含基线历史的仓库根目录运行；Python浏览器测试还需要OpenSSL及Playwright对应浏览器。
浏览器安装命令只下载测试工具，测试预约流量由本机Mock终止。

```sh
node --test tests/userscript/*.test.mjs tests/userscript-p53/*.test.mjs tests/userscript-p60/*.test.mjs tests/userscript-p62/*.test.mjs tests/userscript-p63/*.test.mjs tests/userscript-p64/*.test.mjs
npm run build:userscript:p64
python -m pip install playwright==1.62.0
python -m playwright install chromium firefox
python tests/userscript-p64/browser.py chromium
python tests/userscript-p64/browser.py firefox
node --check userscripts/HDU_Android_P6.4_Lite.user.js
git diff --check
```

本次实际Chromium命令额外设置 `CHROMIUM_PATH=/usr/bin/chromium`；
Firefox命令设置 `PLAYWRIGHT_BROWSERS_PATH=/workspace/work/p64-browsers`。
默认命令使用Playwright自己的浏览器目录，也可按测试环境指定上述路径。
变更文件的Biome lint结果保存在lint.log：无错误、无警告，2条非阻断的模板字符串建议。
测试日志保留工具原输出（含格式化空白），不清洗失败证据。
完整提交的空白检查应排除这些原始log文件：
`git diff --check dccafec5d02993cb31e85f9d19bee6e9e461ee7f HEAD -- . ':!docs/evidence/p64/*.log'`。
