# iPad V10.0 Lite 验证报告

安装文件来自 `203b87669ed2b65a5e50da5f195209a298082571`。ZIP 在 releases 目录，包含同一脚本、中文安装说明和简明变更。JS SHA-256 为 `d8b68b609dec45963c6efbc0c38bca2cb07cbaeb49406a4ceebb0913a41dcb7e`，ZIP 为 `2077eeed36cc155eca22aa72ec1e38030cd97241909f162ea13299fa0b960cd7`。[ZIP](../releases/HDU_iPad_V10.0_Lite.zip) · [检查结果](evidence/v10/validation.json)

## 同环境配对测量

Linux、Playwright 1.62.0、桌面 WebKit 26.5，820 × 1180 触屏视口，操作系统模拟时区为洛杉矶。两版加载各自的完整 IIFE。每对样本交替先后顺序，使用独立上下文、真实定时器、原生 fetch 和同一回环 TLS 接收器。账号、座位、09–22、+1200 ms 与成功响应相同。每次均观察到准备 GET × 1、预约 POST × 1、成功核验 GET × 1。馆方真实写入为 0。

表中单位为毫秒。每格依次给出中位数 / P95（最近秩）/ 最大值。lag 为 fetch 调用相对计划的偏差。网络起点来自唯一可归属的浏览器 Resource Timing 条目。归档耗时为每任务各次从历史键读取起至 setItem 返回的累计时间，包括投影、JSON 序列化和写入，不包括首次插入后的过期键清理或整页面渲染。小于浏览器时钟精度的差值可显示为 0。归档发生在 fetch 交出后或零提交任务结束时，发前仍需同步保存原有请求意图。

| 版 | 阻塞 ms | 窗口命中 | lag | fetch → requestStart | fetch → 响应头 | 归档耗时 |
|---|---:|---:|---|---|---|---|
| V9 | 0 | 12/12 | 2 / 13 / 13 | 5.5 / 9 / 9 | 8.5 / 13 / 13 | 0 / 0 / 0 |
| V10 | 0 | 12/12 | 3 / 4 / 4 | 5 / 10 / 10 | 7 / 15 / 15 | 0 / 1 / 1 |
| V9 | 450 | 3/3 | 253 / 253 / 253 | 4 / 6 / 6 | 7 / 10 / 10 | 0 / 0 / 0 |
| V10 | 450 | 3/3 | 255 / 260 / 260 | 9 / 10 / 10 | 11 / 14 / 14 | 0 / 1 / 1 |
| V9 | 1300 | 0/3 | 1104 / 1104 / 1104 | 4 / 5 / 5 | 7 / 8 / 8 | 0 / 0 / 0 |
| V10 | 1300 | 0/3 | 1105 / 1106 / 1106 | 6 / 8 / 8 | 8 / 14 / 14 | 0 / 1 / 1 |

正常前台原版 fetch 在 +1202–1213 ms，新版在 +1202–1204 ms。本机 HTTPS 接收端最迟分别为 +1223.5 和 +1213.7 ms。新版成功任务共进行三次归档，分别保存交出请求、受理及记录核验。

短、长阻塞从开放后约 1000 ms 开始。长阻塞跨过窗口，所有迟到样本均保留。正常负载每版 12 次；此样本量的 P95 与最大值相同。样本覆盖本机抖动，无法从中推算真机达标概率或服务端开放时刻。[发布包全部样本](evidence/v10/timing.json) · [开发期第一组原始对照](evidence/v10/timing-prerelease.json) · [旧标签核验修复前的原始对照](evidence/v10/timing-before-review-fix.json)

## 验收

| 项目 | 状态 | 结果 |
|---|---|---|
| 签名、参数、边界、分类与存储 | PASS | 131 项 Node 回归通过；包括 27 项 V9、97 项原手机测试、7 项 V10 新测试。上游固定 Go 实现 123 个向量匹配。 |
| 页面回归 | PASS | V9 与发布 V10 都通过 WebKit 和 Chromium 各 14 组，包括双标签、进程丢失边界、限流、人工补交条件、旧脚本共存和交出时间。 |
| 发布包 WebKit 专项 | PASS | 22 项结果见 JSON。成功、快速未开放、延迟 2.2 秒座位拒绝、已有预约、404、断网、不完整 JSON、超过 30 秒写超时均覆盖。9 秒后返回的成功、实际 5 秒读超时、后续匹配及读 404 分开验证。另有 Node 响应头已到而响应体超时用例。 |
| 历史与安全 | PASS | 32 次独立启动仅保留最近 30 条。对八种提交终态逐一刷新、同源重开并复制比对。核对 API 请求序列，归档操作产生 0 个接口请求。删除历史后未决重叠依然阻止写入；清除模拟保护行后独立历史仍可读取。 |
| 浏览器能力 | PASS | Web Locks 缺失、拒绝，存储拒写、历史键配额异常，Resource Timing 缺失、生命周期和时钟跳变均有断言。含截断 body 和认证拒绝。真实 V9/V10 互斥与双向未决记录兼容均有用例。 |
| 整点网络与单次提交 | PASS | 正常任务首个提交前新增 0 个网络请求，每任务 1 个预约 POST，无并行、自动补发或校时服务。读取历史产生 0 个预约 POST。 |
| 正常前台调度 | PASS | 本轮两版都 12/12 命中 800–2000 ms。未发现可重复的明显调度退化。 |
| 长阻塞仍在目标窗口 | FAIL | 1300 ms 阻塞组两版均 0/3，脚本记录真实迟到。 |
| 安装产物 | PASS | 元数据位于首字节，版本 10.0.0，范围为馆方 HTTPS 页面，grant none。ZIP 可解压、CRC 通过、脚本与测试文件逐字节一致。 |
| 11 月 24 日 iPad 原始回执重建 | NOT_TESTED | 缺少当时的执行快照和同步时钟证据。 |
| iPad 真机 | REAL_DEVICE_PENDING | 扩展安装/隔离、真实 Safari 生命周期与资源计时、站点存储持久性、校园网及高峰官方回执仍需实机。 |

## 复现

仓库根目录安装 Vite 锁定依赖，浏览器夹具需要 Python 3.11+、OpenSSL、Python Playwright 1.62.0、对应 Chromium/WebKit 及宿主依赖。使用系统 Chromium 时可设置 CHROMIUM_PATH。旧版共存用例需要本地有 fix/ipad-p731-release-qa 的 Git 对象。

```sh
bun install --frozen-lockfile
npm run build:userscript:v10
node --test tests/userscript*/*.test.mjs
node tests/userscript-v9/upstream-signatures.mjs /path/to/AlaIchhe-upstream
python3 tests/userscript-v10/baseline.py
python3 tests/userscript-v9/browser.py
python3 tests/userscript-v10/regression.py
python3 tests/userscript-v10/audit.py
python3 tests/userscript-v10/compare.py
```

[链路审计与实战证据边界](IPAD-V10-AUDIT.md) · [实机验收与回滚](IPAD-V10-INSTALL.md)
