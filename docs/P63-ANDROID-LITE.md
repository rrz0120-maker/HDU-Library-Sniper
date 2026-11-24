# Android P6.3 Lite 安装与验证

在 Android Firefox 的 Tampermonkey 中停用旧版，打开[固定提交安装文件](https://raw.githubusercontent.com/rrz0120-maker/HDU-Library-Sniper/ca456d8c8e3e2eb7004817c2cc4b734a373b44ba/userscripts/HDU_Android_P6.3_Lite.user.js)，安装后刷新馆方页面。面板摘要应显示 P6.3。默认偏移仍为 1350 ms。回滚时停用 P6.3，启用或安装 [P6.2 Lite](https://raw.githubusercontent.com/rrz0120-maker/HDU-Library-Sniper/e895b995c414cd49944fac28d149fb0e832ee1ac/userscripts/HDU_Android_P6.2_Lite.user.js) 并刷新。保留站点数据可继续使用原有未决请求保护。

## 查看一次运行

“复制诊断日志”导出当前结果，刷新后可以导出上次结果。“查看最近30次运行”读取此浏览器、此站点的本地历史。选中一条记录可查看或复制完整 JSON。新打开的标签页也能查看历史。历史浏览和复制均无网络请求。“核验官方记录”是用户单独触发的联网操作。

每次启动分配独立 UUID。发送后持久化未决快照，收到结果、停止或手动核验后更新相应记录。历史存储使用独立键和跨标签页写锁，最多保留 30 次。发送前仍在账户锁内保存必要的写入意图。历史写入异常时面板提示复制日志。清理浏览器站点数据会清除本地历史。

失败文案字段只保留馆方响应中命中的已知短句，其余自由文本以 null 保存。导出采用字段白名单。SUCCESS 表示曾经匹配到官方记录，verifiedAt 是首次匹配时间。最近一次核验遇到错误时保留先前确认，verification 单独记录 ERROR、AUTH_REQUIRED 或 LIMITED。最近一次明确查无匹配时显示 ABSENT，并按原核验规则更新 recordVerified。

## 时间字段

| 字段 | 采样点 |
|---|---|
| preparedAt / plannedAt | 准备完成的本地时间 / 预约计划触发时间 |
| dispatchAt / scheduleLagMs | 写入意图成功后、调用 fetch 时采样的本地时间 / 相对计划时间的差值 |
| clockChangeMs | 从准备到发送，墙钟增量与单调时钟增量之差 |
| requestStartAt | 浏览器提供唯一匹配的 Resource Timing 条目时，将 requestStart 映射到本地时间。馆方实际收包时间未知 |
| requestToFirstByteMs / responseDownloadMs | 浏览器的 requestStart 到 responseStart、responseStart 到 responseEnd，缺失或无法归属时为 null |
| responseAt / httpMs | fetch 返回响应头时的本地时间 / 从调用 fetch 到观察到响应头的单调时钟耗时 |
| businessAt / verifiedAt | 完成响应体 JSON 解析 / 首次官方记录匹配 |
| storageStatus | SAVED 表示归档写入成功，ERROR 表示观察到存储异常，null 表示尚无确认 |

## 验证范围

基线分支头为 e895b995c414cd49944fac28d149fb0e832ee1ac。通过本地 TLS 接收器加载完整 userscript，浏览器使用本地代理。两版正常链路均观测到准备期 3 个 GET、到点 1 个正式 POST、受理后 1 个官方记录 GET。新增网络请求 0，馆方真实测试预约 0。

| 验证 | 结果 |
|---|---|
| Android 相关现有 Node 回归 | 基线及新版各 97/97 |
| 固定上游 Go 签名向量 | 123/123 匹配 |
| 项目 Vitest / Web 构建 | 34/34，构建成功 |
| 原有浏览器用例 | 基线和新版均在桌面 Chromium 151 与 Firefox 153 各通过 17 组 |
| 新增浏览器回归 | 两个引擎各通过 2 组。覆盖成功、失败刷新及新标签页恢复、复制脱敏 JSON、最新核验异常、32 次运行截断至 30 条、存储拒写、停止、时钟跳变、清空历史后的未决去重 |
| 安装文件 | Vite 7.3.8 构建、Node 语法检查、重复构建与提交固定 raw 文件逐字节比对通过。SHA-256 为 `5dfafed08e624d4acab18700b71c5346d1cc752682a25636a5f4c0d0db1b86a0` |

本地复现使用 `npm run build:userscript:p63`、`python tests/userscript-p63/check.py chromium`、`python tests/userscript-p63/check.py firefox` 和 `python tests/userscript-p63/check.py --bench`。浏览器测试需要 Python Playwright 及其对应的浏览器二进制文件。

Android Firefox + Tampermonkey 安装、真实手机前后台切换和系统休眠、真机 Resource Timing 可用性、馆方高峰网络表现均为 **REAL_DEVICE_PENDING**。

## 调度性能对照

桌面 Firefox 153、相同 412 × 860 视口、同一本地 TLS 接收器和 1350 ms 偏移。每一对样本交替两版的先后次序，使用真实计时器。表中指标是 dispatchAt 减 plannedAt，单位 ms。P95 取最近秩，在本次各组样本量下等于最大值。

| 主线程负载 | 每版样本 | P6.2 中位 / P95 / 最大 | P6.3 中位 / P95 / 最大 |
|---|---:|---:|---:|
| 前台正常 | 12 | 4.5 / 21 / 21 | 3.5 / 8 / 8 |
| 阻塞 450 ms | 4 | 202.5 / 210 / 210 | 202 / 204 / 204 |
| 阻塞 1300 ms | 4 | 1052.5 / 1055 / 1055 | 1059 / 1065 / 1065 |

正常负载两版均有 12/12 落在既有的 20:00 后 800–2000 ms 窗口，样本内未观察到新版调度退化。阻塞从约 20:00:01.100 开始，覆盖计划触发点。450 ms 组仍全部在窗口内。1300 ms 组两版各 4/4 超窗，P6.2 的 4 次误差为 1051、1053、1055、1052 ms，P6.3 为 1054、1063、1055、1065 ms。每个样本都只发送一次。本实验不能推断真机高峰的服务端开放时刻或预约成功率。[全部 40 个原始样本](evidence/p63/timing.json)

新增 Resource Timing 单测 3/3 通过，分别覆盖缺失、唯一和多条候选记录。执行命令为 `node --test tests/userscript-p63/timing.test.mjs`。
