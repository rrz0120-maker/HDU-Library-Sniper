# P5.1 验证记录

基于 `feat/cloud-strict-v3` 的 `50a5faa`，开发分支为 `feat/android-p51-userscript`。没有修改生产 Rust 预约算法、原管理前端或部署配置；Rust 仅增加共享签名向量测试。

| 范围 | 结果 |
|---|---|
| 独立安装包 | `userscripts/hdu-p51.user.js`，无外部脚本依赖，仅匹配官网、仅顶层页面；默认零请求、零写入 |
| 核心/Mock 测试 | 22项通过：只读流程、已开放日期、完整时段构造、映射/冲突、确认门禁、单次写入、162/157分别选择、404/超时/限流/认证失效、停止/暂停恢复、失败后不重发 |
| 签名一致性 | 4组同一 JSON 测试向量经 Rust 与 JavaScript 分别通过；覆盖字符编码、字段顺序、秒单位与 Base64(MD5十六进制文本) |
| 浏览器流程 | 18项通过：Firefox及Chromium各9项，412×915触屏视口，安卓UA；含同源HttpOnly模拟会话、中文面板、无横向滚动、跨标签页原子锁、真正关闭并重开浏览器后的UNKNOWN记录 |
| 打包/检查 | 独立IIFE构建、脚本语法检查、Biome、TypeScript检查通过；生成物可复现 |
| Tampermonkey平台声明 | Mozilla官方插件API：5.5.0，Android Firefox最低120；原始来源 https://addons.mozilla.org/api/v5/addons/addon/tampermonkey/ |
| Android真机+Tampermonkey安装注入 | **未验证**：本环境没有一加手机或Android版Firefox。Playwright将最终脚本注入Mock页面，不是Tampermonkey扩展注入测试 |
| 真实官网登录、开放日期、座位ID及已有预约 | **未验证**：只读程序待用户在自己的已登录Firefox运行；没有获取校园凭据 |
| 真实预约/20:00模式 | **未执行/未开发**，等待具体座位、日期、时间及馆方允许条件得到用户确认 |

完整Cloud证据位于 `/workspace/HDU-v3-verification/p51-unit.log`、`p51-browser.log`、`p51-rust-signatures.log`、`p51-style.log`、`p51-typecheck.log`；浏览器JSON和截图位于 `artifacts/p51/`。首次浏览器测试4项重载步骤失败已保留于 `p51-browser-attempt1.log`：测试直接再次导航相同hash网址未可靠更换文档，修为完整文档重载后通过，不涉及放宽防重复断言。

所有预约、会话和目录测试均用本机Mock。浏览器测试拦截所有网络请求，拒绝未列出的端点；未使用真实会话，未发起真实预约。曾读取官网未登录公共入口及Mozilla插件平台元数据，不作为真实账号验收证据。

实际日期契约仍未知。数字型 `advance_date/max_date` 等未知形状会留下脱敏类型日志并禁止提交。不能将Mock中的ISO日期视作生产事实；拿到首次只读日志后再按证据适配。防重复只在同一浏览器/官网数据区内成立，不跨设备，也不与原Rust数据库共享。
