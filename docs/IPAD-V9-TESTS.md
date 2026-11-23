# V9 Lite 模拟性能与验收记录

环境为 Linux、Node 24、Python 3.12、Playwright 1.62.0。使用 Chromium 156.0.8078.79 和桌面 WebKit 26.5 加载可安装文件。整个测试向真实馆方发送 **0** 次写请求。安装包 SHA-256 为 `8dd8bc200d00cbf2b0834c6830a124e0341f289212a5518d2740178dfd7c430b`。

## 首次发出窗口

目标为北京时间 20:00:01.200，达标区间为开放后 800–2000 ms，两端均包含。每种引擎、每种负载独立打开 12 个新的浏览器上下文，共 72 次。下表的数据单位均为毫秒。

| 引擎 | 主线程负载 | 发出命中 | 发出中位数 | 发出范围 | 接收端命中 | 接收端范围 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Chromium | 正常前台 | 12/12（100%） | 1202 | 1201–1209 | 12/12 | 1209.5–1226.2 |
| Chromium | 阻塞 450 ms | 12/12（100%） | 1453 | 1452–1466 | 12/12 | 1460.4–1500.2 |
| Chromium | 阻塞 1300 ms | 0/12（0%） | 2304.5 | 2302–2311 | 0/12 | 2317.8–2346.5 |
| WebKit | 正常前台 | 12/12（100%） | 1203 | 1202–1206 | 12/12 | 1207.3–1214.6 |
| WebKit | 阻塞 450 ms | 12/12（100%） | 1453 | 1451–1458 | 12/12 | 1457.4–1471.0 |
| WebKit | 阻塞 1300 ms | 0/12（0%） | 2304 | 2303–2307 | 0/12 | 2307.4–2313.6 |

两种阻塞条件都在开放后约 1000 ms 启动一个同步回调，分别占用主线程 450 ms 和 1300 ms。实际阻塞起止时间随样本保存。长回调跨过 2000 ms 后，浏览器在恢复执行时才有机会发送，面板会显示超窗。每次测试仍只有一个预约 POST。[全部样本与统计](evidence/v9/timing.json)

测试把浏览器壁钟平移到开放前 650 ms，之后按真实时间流逝。定时器、Web Lock、同步存储、签名和原生 `fetch` 均执行真实代码。浏览器以馆方域名访问仅绑定回环地址的 TLS 模拟服务器。接收端独立记录收到 POST 的时刻，将其换算到同一仿真时轴。这一组时延不包含校园网、真实馆方排队和 iPadOS 调度。[计时程序](../tests/userscript-v9/timing.py) · [HTTPS 夹具](../tests/userscript-v9/mock_huitu.py)

`dispatchAt` 取自将请求交给浏览器的调用位置。另一个边界测试把时钟固定在 +1199 ms，确认零写入，再推进到 +1200 ms。在持久化未决标记处人为增加 145 ms 时，记录与实际 fetch 入口均为 +1345 ms。样本另存浏览器能提供的 `requestStartAt` 和响应头耗时，供独立对照。

## 功能验收

27 项 V9 Node 测试和 97 项手机端既有 Node 测试通过。独立运行上游固定提交的 Go `ApiToken`，3 个手机固定向量与全部 120 种受支持整点时段均匹配。两个浏览器分别通过 14 组页面场景。[Node 用例](../tests/userscript-v9/core.test.mjs) · [上游签名比对](../tests/userscript-v9/upstream-signatures.mjs) · [页面用例](../tests/userscript-v9/browser.py)

| 需求序号 | 检查与观察 |
| --- | --- |
| 1、2 | 比对上游 Go 源码、手机固定向量、完整的六字段 URL 编码表单及签名头。HTTPS 夹具独立重算签名并检查当前会话 Cookie。 |
| 3、4 | 校验 09–22 的 46800 秒、08–22 的 50400 秒、其他合法整点及跨月跨年；从官方结构夹具解析楼层 1558、座号 162、ID 62726。重复映射会被识别。 |
| 5、6、15 | 检查 +1200 ms 触发和实际 fetch 边界。首次运行的完整馆方请求顺序为 baseInfo GET、bookSeats POST、myBookingList GET；两端计时独立。 |
| 7 | 受理后只读核验。记录仍匹配时再次启动保持一次 POST。在官网模拟取消后，可以发起新的合法预约。 |
| 8、9、10 | 使用真实文案形态模拟未开放、座位不可用、业务限流和 HTTP 429。明确拒绝后无自动续写。试验人工补交的读回范围、排除上界、间隔和次数；限流跨刷新及不同时段有效。 |
| 11、12 | 模拟隐藏、失焦、恢复前台、主动停止、待命中刷新和再次授权，均可保留或重新启动零提交任务。还覆盖同日超窗和跨日恢复。 |
| 13、14 | 两标签争用、已发待响应时刷新、网络断开、HTTP 504、无效响应和 30 秒超时。未决请求只读核验。强制重建进程中断时的未决标记，次数未知会导出 null。 |
| 16、17 | Chromium 和 WebKit 跑同一安装文件、同一 HTTPS 夹具和上述正常、阻塞计时。页面另测横竖屏、窄屏、剪贴板失败和诊断存储异常。 |
| 18 | 分别装入真实 P6.1.1、P7.3.1 安装文件，交换与 V9 的加载顺序。旧版先加载，V9 禁止本页启动；V9 先加载，旧入口识别已有宿主后退出。相同页面重复注入 V9 也只有一个面板。官网模拟按钮仍可独立发送，其 fetch 身份保持一致。迁移时须关闭此前单独运行旧版的标签页。 |

## 复现

在仓库根目录执行。构建使用已有 `bun.lock` 和 Vite。浏览器测试需要 Python ≥3.11、OpenSSL、Playwright 的两个浏览器及宿主依赖。若只克隆了 V9 分支，先取得 P7.3.1 的固定提交供共存测试读取。

```sh
bun install --frozen-lockfile
npm run build:userscript:v9
node --test tests/userscript-v9/*.test.mjs tests/userscript/*.test.mjs tests/userscript-p53/*.test.mjs tests/userscript-p60/*.test.mjs
git clone https://github.com/AlaIchhe/HDU-Library-Sniper /tmp/hdu-upstream
node tests/userscript-v9/upstream-signatures.mjs /tmp/hdu-upstream
git fetch origin fix/ipad-p731-release-qa
python3 -m pip install playwright==1.62.0
python3 -m playwright install --with-deps chromium webkit
npm run test:userscript:v9:browser
python3 tests/userscript-v9/timing.py --samples 12 --output /tmp/v9-timing.json
```

本次 Chromium 使用环境已有的 `/usr/bin/chromium`，可通过 `CHROMIUM_PATH` 指定。WebKit 使用 Playwright 的 Linux WPE 构建。Go 比对程序读取固定上游提交里的 `internal/hdu/crypto.go`，可通过 `GO_BINARY` 指定 Go 编译器。[真机待验收清单](IPAD-V9-LITE.md#ipad-真机待验收)
