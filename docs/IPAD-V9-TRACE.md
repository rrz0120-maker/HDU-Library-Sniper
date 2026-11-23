# V9 协议溯源与五晚复盘

上游读取版本为 `AlaIchhe/f1055c9`。手机对照版本为 P6.0 `d144d47` 和 P6.1.1 `4313031`，V9 分支从后者新建。两个手机版本在 `DailyEngine.submit` 里包装诊断回调，实际正式提交均委托给 `SingleEngine.submit`。V9 与手机端共享同一份签名及表单实现。原手机入口保留其 1 小时和 14 小时校验；V9 在自己的时段选择处校验。P6.1.1 安装包的 SHA-256 仍为 `35806dfd7ab9633dc44c4fd83b9d047d493211827191c295708e3aae9064539b`。[P6.0 提交](https://github.com/rrz0120-maker/HDU-Library-Sniper/tree/d144d479c6daeef61314ffe6e72beaf436560291) · [P6.1.1 提交](https://github.com/rrz0120-maker/HDU-Library-Sniper/tree/4313031b6c5059003314de482207ba539e1b06ca)

| V9 函数或数据 | 移植依据与改动 |
| --- | --- |
| `login` | 准备时同源 GET `/User/Center/baseInfo`，从 `DATA.is_login` 和数字 `uid` 取得已登录身份。本端点省略 `LAB_JSON`。沿用 Safari 自己的会话 Cookie。[上游 ValidateOnce](https://github.com/AlaIchhe/HDU-Library-Sniper/blob/f1055c9713c7b5917c4ef4d6d1c959864e41f05c/internal/hdu/client.go) · [手机 login](../src/userscript/p53/engine.js) |
| `SEAT` | 官方座位图位于 `allContent.children[2].children.children`。手机 `resolve162` 唯一匹配房间、`seatMap.info.id=1558`、`POIs[].title=162` 和 `id=62726`。V9 直接引用手机常量，测试用官方结构夹具解析、对照。其他时段的占用状态不决定目标时段的预约结果。[上游 Floors](https://github.com/AlaIchhe/HDU-Library-Sniper/blob/f1055c9713c7b5917c4ef4d6d1c959864e41f05c/internal/hdu/catalog.go) · [手机映射](../src/userscript/p53/policy.js) · [脱敏实战映射](evidence/p60/p53-real-peak.json) |
| `makeTask` | 上游自习室开放锚点为上海时间 20 点，非生活区默认后天。P6 `dailyTask` 以北京时间午夜计算 Unix 秒。V9 复用规则，时长为结束减开始的小时数乘以 3600。例：11 月 22 日 20:00 放出 11 月 24 日。[上游时间规则](https://github.com/AlaIchhe/HDU-Library-Sniper/blob/f1055c9713c7b5917c4ef4d6d1c959864e41f05c/internal/core/time.go) · [手机 dailyTask](../src/userscript/p60/policy.js) |
| `bookSeatRequest`、`submitPrepared` | 从 P6 共用的 `signedRequest` 抽出原函数体。`beginTime`、`duration`、`is_recommend=0`、即时秒级 `api_time`、`seats[0]`、`seatBookers[0]` 编码为表单。按原字段次序构造签名串，MD5 转小写十六进制后将其 ASCII 文本 Base64，置于 `Api-Token` 头。两个模式均调用 `POST /Seat/Index/bookSeats?LAB_JSON=1`。[上游 BookSeat](https://github.com/AlaIchhe/HDU-Library-Sniper/blob/f1055c9713c7b5917c4ef4d6d1c959864e41f05c/internal/hdu/booking.go) · [上游 ApiToken](https://github.com/AlaIchhe/HDU-Library-Sniper/blob/f1055c9713c7b5917c4ef4d6d1c959864e41f05c/internal/hdu/crypto.go) · [手机共享 core](../src/userscript/core.js) |
| `classify`、`verify`、`matchesRecord` | 复用手机 `responseCode`，按实测契约认定业务成功，并细分 HTTP、明确拒绝与不明结果。错误原文优先 `DATA.msg`，然后 `MESSAGE`。沿用 `myBookingList?fromType=web&LAB_JSON=1` 和 `content.defaultItems`，核对有效状态、开始秒、时长、房间与座号，存在座位或楼层 ID 时也核对。[上游核验](https://github.com/AlaIchhe/HDU-Library-Sniper/blob/f1055c9713c7b5917c4ef4d6d1c959864e41f05c/internal/booking/executor.go) · [手机 verified162](../src/userscript/p53/policy.js) · [V9 收发与核验](../src/userscript/v9/network.js) |
| `confirmOpen` | 沿用手机 `roomQuery`、`parseRange` 及馆方日期控件的排除上界 `max_date`。调用点仅为用户对明确 `NOT_OPEN` 的人工补交。首次整点 POST 路径上没有该调用。[日期边界证据](evidence/p52/date-control.json) · [V9 调用位置](../src/userscript/v9/engine.js) |
| `waitUntil`、`Booking` | 上游 `bookingLoop` 提供 20:00 锚点。V9 独立使用本地单一计时器、可见性唤醒和可取消的等待。准备时取得登录身份和活动写入互斥。触发后仅执行本地检查、签名、必要的同步未决标记和 `fetch`。[上游 scheduler](https://github.com/AlaIchhe/HDU-Library-Sniper/blob/f1055c9713c7b5917c4ef4d6d1c959864e41f05c/internal/scheduler/scheduler.go) · [V9 调度](../src/userscript/v9/engine.js) |
| `Guard.intent`、`recall` | 新实现。活动 Web Lock 防同一账号在本浏览器中并行写入。目标日期及起止小时组成未决请求键。刷新可恢复回执，准备和零提交停止均不消耗次数。账户散列只作本地键。[V9 未决保护](../src/userscript/v9/guard.js) |
| `diagnostic`、`mount` | 延续手机诊断的白名单原则。新增浏览器请求起点、超窗标记、可折叠面板，以及对已知旧版启动入口的互斥。官网按钮、fetch 和 XHR 保持原生调用路径。[V9 字段](../src/userscript/v9/policy.js) · [界面入口](../src/userscript/v9/entry.js) |

## 五晚手机记录

下表中 11 月 18、20、21、22 日的时刻或结果来自本次任务提供的摘要。Fork 中找到了 11 月 19 日的回执摘录，以及更早的 11 月 17 日已核验实战摘要。检索到的仓库材料中没有另外四晚的逐事件原始导出。另有 P7.0 的 **非整点、1 小时** iPad 真机记录，可查到同一座位的正常预约回执。[11 月 19 日摘录](P61-OPEN-CONFIRMATION-DRAFT.md) · [11 月 17 日摘要](evidence/p60/p53-real-peak.json) · [旧版 iPad 普通预约记录](https://github.com/rrz0120-maker/HDU-Library-Sniper/blob/0882ace2dc4cdec062112158be444590f58c7488/docs/evidence/p70/ipad-phase1-real-booking-20261120.json)

| 北京时间 | 结果 | 从日志与源码可以确认的内容 |
| --- | --- | --- |
| 11 月 18 日 20:00:01.280 | P6.0 成功 | P6.0 在准备阶段获得正确的座位映射和身份，到点生成签名、提交一次正式 POST，再查记录。这一晚的发出时刻落在本次目标窗口内。 |
| 11 月 19 日 20:00:00.440 | NOT_OPEN | 仓库摘录记载 .550 收到未开放，.743 显示失败，后又降级为 UNKNOWN。P6.0 的本地时钟和秒级 HTTP Date 门槛已经放行，当时的预约业务端仍拒绝目标时段。服务端准确开放时刻、设备钟差均无法由此反推。 |
| 11 月 20 日 20:00:03.572 | P6.1.1 成功 | `DailyEngine.tick → submit → SingleEngine.submit → signedRequest → Transport.request(bookSeats)`。成功核心仍是相同签名、表单、会话和记录核验；P6.1.1 在此路径前添加了开放确认。 |
| 11 月 21 日，零发送 | 提交前停止 | P6 的隐藏页、freeze、pagehide 都可触发 `suspend → stopSignal`，同日 stop 标记或历史任务行可使下次启动失败。P7 的入口也有类似监听。现有摘要可证明零发送，不能区分当天首先触发的是哪个事件或是否手动停止。 |
| 11 月 22 日 20:00:04.189 | SEAT_UNAVAILABLE | 摘要给出开放检查额外耗时 2858 ms。P6.1.1 在放行后等待日期 GET 回包、解析排除上界；仍闭时至少等 1 秒，最多再读一次。这段等待串行推迟 POST。缺少逐事件导出，无法区分当晚 GET 次数、各次 RTT 或馆方排队耗时，也无法判断提前发送是否会得到该座位。 |

## 限流依据

上游实测亚秒级、3 秒、5 秒节拍均曾触发限流或封禁。已有写入消耗时，10 秒间隔的第二次写入也曾被封禁。业务拒绝同样消耗额度。预锁和提交前重查座位图均不是馆方受理的必要条件。V9 每次启动只提交一次，限流立即停写，未知结果只读核验。手机旧实现的固定两分钟准备窗、每日停止位、旧版成功凭据、持久化次数预算，以及整点开放 GET 均已退出首次提交路径。[上游 HUITU-LIMITS 第 1–5 节](https://github.com/AlaIchhe/HDU-Library-Sniper/blob/f1055c9713c7b5917c4ef4d6d1c959864e41f05c/docs/HUITU-LIMITS.md) · [P6.1.1 tick 和停止逻辑](https://github.com/rrz0120-maker/HDU-Library-Sniper/blob/4313031b6c5059003314de482207ba539e1b06ca/src/userscript/p60/engine.js) · [P6.1.1 页面事件](https://github.com/rrz0120-maker/HDU-Library-Sniper/blob/4313031b6c5059003314de482207ba539e1b06ca/src/userscript/p60/entry.js)
