# P4 部署验收记录

## 代码与权限

- 基线 `a3ae4a1216c7e7184cc2c484f430d488aac6b77f` 保留；工作区起始干净。
- Fork：<https://github.com/rrz0120-maker/HDU-Library-Sniper>，当前用户具备push权限。
- 分支：<https://github.com/rrz0120-maker/HDU-Library-Sniper/tree/feat/cloud-strict-v3>，已成功推送。
- 原作者仓库确认 `push=false`；本阶段未向原仓库重试推送。
- P4只改构建、验收脚本、忽略规则及部署文档；相对a3ae4a1，`crates/`、`src/`、Cargo.lock和前端依赖未改。

原交付物完整性：bundle通过Git校验；源码归档逐文件字节匹配a3ae4a1；补丁与 `46ccd47..a3ae4a1` 完整binary diff一致。原文件未覆盖。

| 原交付物 | SHA-256 |
|---|---|
|HDU-Library-Sniper-v3.bundle|f68bfc7ceb2f86599dab12a436313b97fff88ba066418d7cc5d4d26ef4c4de2e|
|HDU-Library-Sniper-v3.patch|cfa082a26434638078277766514820b16b2c2332bf9d397ad490616e2e1ee08a|
|HDU-Library-Sniper-v3-source.tar.gz|2b967fe202e44de142621d9b3509aa52da77b4f91fe051f75aadb1cabc61b581|

敏感文件检查：未跟踪真实.env、SQLite、私钥、Cookie或凭据文件；常见GitHub/AWS/私钥特征扫描无命中。新增验收仅使用合成身份、空Cookie、临时随机加密密钥，密钥不进入日志。原项目已有公开测试夹具、演示素材和Git作者信息保持原样，本检查不声称历史素材没有个人信息。补充了SQLite/WAL、私钥、凭据JSON及部署.env的Git和Docker忽略规则。

## 构建与容器结果

**最终结果：成功。** [GitHub Actions 完整运行](https://github.com/rrz0120-maker/HDU-Library-Sniper/actions/runs/43724591166)

- 构建提交：[`4c2213a`](https://github.com/rrz0120-maker/HDU-Library-Sniper/commit/4c2213aabd667fbd9c7b9ed9a78b708875a14c55)。
- Linux amd64镜像：`ghcr.io/rrz0120-maker/hdu-library-sniper:v3-sha-4c2213aabd667fbd9c7b9ed9a78b708875a14c55`。
- 部署固定digest：`ghcr.io/rrz0120-maker/hdu-library-sniper@sha256:ad2185db92068bdca64a5fbb49cd7b173af197d518b879606ce8f002a9607cff`，已预填 `deploy/env.example`。
- 完整构建、容器启动、HTTP `/api/health`、二进制健康检查均通过。
- 临时空卷默认无任务；每日模式、真实写入、自动签到均关闭。
- 合成账号持久化意图不重发；重复开始复用原任务；每日开启请求被拒绝；旧签到开关被严格模式压制。
- `docker restart` 与删除/重建容器后，同一数据卷保留任务、UNKNOWN保护和审计；手动接管通过。
- 测试容器使用 `--network none`，探针仅共享该命名空间；没有真实账号、馆方请求或生产卷。
- 验收通过后才发布GHCR；完整日志及JSON证据见该运行的 `v3-acceptance-4c2213aabd667fbd9c7b9ed9a78b708875a14c55` Artifact（保留30天）。
- 当前为首个通过P4容器验收的镜像，尚无上一合格镜像可供回滚；紧急情况停服务，保留数据卷。

首轮：<https://github.com/rrz0120-maker/HDU-Library-Sniper/actions/runs/43723308077>

- Linux amd64完整镜像构建成功。
- 容器验收脚本假设隔离网络存在发布端口，端口探测失败；发布被阻止。
- 构建完整日志、失败堆栈及容器报告已保留在该Actions Artifact，本地也保留副本。
- 修复仅涉及验收探针；改为应用 `--network none`，Python探针共享其网络命名空间，不发布端口且无法连接馆方。

其他未发布的失败记录同样保留：

- [第二轮](https://github.com/rrz0120-maker/HDU-Library-Sniper/actions/runs/43723841961)：构建及空卷启动通过；合成SQLite夹具未关闭WAL，恢复检查失败。
- [第三轮](https://github.com/rrz0120-maker/HDU-Library-Sniper/actions/runs/43724212221)：恢复读取通过，但主文件回拷后的写入检查失败。夹具改为在隔离测试卷内直接生成，避免主文件/WAL和所有权跨宿主机复制的问题；最终完整验收通过。预约代码未修改。

本地部署准备已通过：Compose解析；P4写入/验收门禁固定0；amd64；回环监听；命名卷；重启策略；只读根文件系统。只读SQLite辅助脚本用合成数据库验证，数据库字节未改变且输出不含UID。

## 真实环境状态

| 项目 | 实际结果 |
|---|---|
|云服务器部署|未部署；未提供目标服务器及访问授权|
|管理端外网/认证网络开放|未执行；仅准备Tailscale Serve+ACL+HTTPS步骤|
|真实校园登录及会话检查|未执行；无真实凭据及登录授权|
|真实四楼162/157内部ID|未验证；没有把合成测试ID当成真实ID|
|馆方当前后天日期及14小时规则|未在线核验；仍按已约定契约，待授权后只读复核|
|真实已有预约检查|未执行|
|真实20:00调度与真实预约|未验证；真实写入强制关闭|
|iPad/安卓真实设备访问|本阶段未实机验证；前阶段已有Chromium/WebKit模拟测试|

真实只读验收与手机操作顺序、密钥生成、部署命令、备份和回滚见 [P4部署手册](V3-P4-DEPLOYMENT.md)。P4配置不会启动未经授权的真实预约。任何真实登录、只读会话检查、真实写入及管理服务网络开放，均等待相应明确授权。
