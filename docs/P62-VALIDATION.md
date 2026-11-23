# P6.2 Lite 验收记录

本版本标记为 **Android Firefox 真机待验收**。源码从 P6.1.1 指定提交建立。构建产物为 `HDU_Android_P6.2_Lite.user.js` 和含脚本、中文说明、LICENSE 的 ZIP。模拟过程向真实馆方发送 **0** 次写请求。

## 首发时延

固定目标为北京时间 20:00:01.350，达标区间为开放后 800–2000 ms。使用真实浏览器定时器、正式安装文件、原生 fetch 和回环 HTTPS 服务。每种浏览器、每种负载 12 次独立上下文，总计 72 次。下表单位均为毫秒。

| 浏览器 | 主线程负载 | 发出命中 | 发出中位数 | 发出范围 | 接收端命中 | 接收端范围 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Chromium | 正常前台 | 12/12（100%） | 1352 | 1351–1355 | 12/12 | 1358.2–1365.7 |
| Chromium | 阻塞 450 ms | 12/12（100%） | 1554 | 1551–1556 | 12/12 | 1560.5–1567.9 |
| Chromium | 阻塞 1300 ms | 0/12（0%） | 2405 | 2402–2446 | 0/12 | 2411.0–2467.0 |
| Firefox | 正常前台 | 12/12（100%） | 1352.5 | 1351–1355 | 12/12 | 1358.8–1366.2 |
| Firefox | 阻塞 450 ms | 12/12（100%） | 1552 | 1550–1556 | 12/12 | 1558.4–1565.2 |
| Firefox | 阻塞 1300 ms | 0/12（0%） | 2401.5 | 2400–2405 | 0/12 | 2407.1–2424.1 |

同步阻塞在开放后约 1100 ms 开始，分别持续 450 ms 和 1300 ms。每个样本保留实际阻塞起止、浏览器 fetch 发出时刻、可获取的 Resource Timing 请求起点、独立 TLS 接收端时刻以及 HTTP 响应耗时。超过 2000 ms 的样本均标记 `inWindow=false`。[全部样本](evidence/p62/timing.json)

浏览器壁钟平移到开放前约 850 ms 后按真实时间流逝。准备阶段在开放前完成 GET 身份、类目、时段范围。待命后的第一个网络请求是预约 POST，随后仅成功回执会自动查询官方记录。测试服务只处理模拟 HDU 域名，所有连接都由本地代理终止，代理禁止向外转发。[计时程序](../tests/userscript-p62/timing.py) · [TLS 夹具](../tests/userscript-p62/server.py)

这组结果覆盖 Linux Chromium 156.0.8078.79 和桌面 Firefox 153.0。它不包含 Android 系统挂起、手机节电策略、Tampermonkey 安装运行、校园网及真实馆方排队。

## 请求核心与行为

- **97 项 Node 测试通过**，覆盖共享手机协议、P6.2 策略、去重存储和 Transport 计时、超时、HTTP 处理。自动从两个指定手机提交载入签名函数，比较 token 和完整编码表单，包括字段顺序。
- **123 组上游 Go 签名一致**，直接编译上游固定提交的 `internal/hdu/crypto.go`。包含 3 个手机固定向量及全部 120 种允许的整点时段。
- **Chromium 和 Firefox 各通过 17 组页面场景**。测试使用实际可安装 IIFE 文件，检查同源 Cookie、请求头和表单，由接收端独立重算签名。
- 构建、JavaScript 语法、Biome 检查、旧安装包 SHA-256、ZIP 完整性和 ZIP 内脚本与单文件一致性均通过。

| 用户要求 | 具体覆盖 |
| --- | --- |
| 1 | P6.0、P6.1.1 和 P6.2 token、六字段顺序及表单逐项比较，独立 Go 再校验。 |
| 2–4 | 固定时钟 +1349 ms 时零预约写入，+1350 ms 时发送。删除所有 OPEN_RANGE 相关条件后直接执行。额外同步意图耗时 125 ms 时，dispatchAt 和 fetch 入口均为 +1475 ms。 |
| 5、6 | 准备阶段只有三次 GET。完成待命后让预检端点返回错误，正式路径仍仅 POST 和成功后的记录 GET。 |
| 7–10 | 完整 SERVER_SUCCESS→记录核验、NOT_OPEN、SEAT_UNAVAILABLE、业务限流、HTTP 429 和 AUTH_REQUIRED。429 响应头即停止写入，业务码在响应体解析后补全。 |
| 11、12 | 19:59 隐藏、freeze、pagehide、恢复、手动停止、重新启动，以及零发送时刷新。旧 stop 存储位不参与新任务决策。 |
| 13、14 | 发送后刷新、断网、504、非法 JSON、30 秒超时以及进程中断边界。后续只有主动只读核验，未知次数保留 null。 |
| 15 | 同日 +8200 ms 恢复显示实际迟到并发送一次，跨日恢复保持零发送。另有上述真实主线程阻塞实验。 |
| 16 | 两标签同时启动，活动账号互斥使第二页显示冲突。原请求成功后新页面读取结果，共一次 POST。 |
| 17 | dispatchAt 位于同步意图后、实际 fetch 调用处。人为增加 UI 观察回调时间不改变已记录的发出时间，接收端时钟独立对照。 |
| 18 | 加载真实 P6.0、P6.1.1 安装文件并交换加载顺序。旧版先运行时 P6.2 禁止本页启动；P6.2 先运行时旧入口退出。官网手动按钮与原生 fetch 仍可操作。 |

补充覆盖了 09:00–22:00、800 ms 偏移、时长不合法后修正、记录查询失败、取消旧记录后新申请、剪贴板失败、日志存储失败和窄屏横竖屏。复制日志使用字段白名单，模拟 UID、Token 文本和私人姓名均未出现在导出 JSON 中。

## 复现

在仓库根目录执行。构建使用已有 Vite 依赖，ZIP 用 Python 标准库生成。浏览器测试需要 Python ≥3.11、OpenSSL、Playwright 1.62.0 及浏览器依赖。使用系统 Chromium 时可设置 `CHROMIUM_PATH`。签名比对可通过 `GO_BINARY` 指定 Go。

```sh
bun install --frozen-lockfile
npm run build:userscript:p62
node --test tests/userscript/*.test.mjs tests/userscript-p53/*.test.mjs tests/userscript-p60/*.test.mjs tests/userscript-p62/*.test.mjs
git clone https://github.com/AlaIchhe/HDU-Library-Sniper /tmp/hdu-upstream
node tests/userscript-p62/upstream-signatures.mjs /tmp/hdu-upstream
python3 -m pip install playwright==1.62.0
python3 -m playwright install --with-deps chromium firefox
npm run test:userscript:p62:browser
python3 tests/userscript-p62/timing.py --samples 12 --output /tmp/p62-timing.json
```

发布采用 GitHub Git Data API 上传本地已提交的树与提交对象，并核对提交 SHA 和分支引用。P6.1.1 成功安装包的 SHA-256 为 `35806dfd7ab9633dc44c4fd83b9d047d493211827191c295708e3aae9064539b`。[安装包校验清单](../userscripts/SHA256SUMS) · [安装说明及真机验收清单](P62-ANDROID-LITE.md) · [溯源、改动与保护理由](P62-CHANGES.md)
