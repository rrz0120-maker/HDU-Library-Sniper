# P4 部署与移动端验收

本阶段基于 `a3ae4a1`，只调整镜像、CI、部署配置和验收脚本。Rust预约算法及Web前端不变。
实际镜像、提交、CI结果见 [P4 验收记录](V3-P4-ACCEPTANCE.md)。下面是操作准备，不能代表云服务器已部署。

## 1. 镜像与服务器

目标：单用户Linux amd64常驻服务器，Docker Engine + Compose插件，系统NTP已同步。服务器不必安装Rust/Bun，也不需要在服务器编译。

```bash
git clone --branch feat/cloud-strict-v3 https://github.com/rrz0120-maker/HDU-Library-Sniper.git
cd HDU-Library-Sniper
```

检出验收记录中的部署提交。使用验收通过的 `ghcr.io/rrz0120-maker/hdu-library-sniper:v3-sha-<完整构建SHA>`，更推荐直接使用报告中的 `@sha256:...`。不要使用 `latest`。

若镜像为私有，在服务器通过Docker凭据存储登录GHCR，令牌只需读取该镜像的权限；不要把令牌写进Git或命令历史。可用交互式 `docker login ghcr.io -u rrz0120-maker`。不要为方便下载将管理服务公开。

## 2. 生成本地配置

在可信服务器上执行；密钥不会输出到终端，文件已被Git忽略：

```bash
python3 - <<'PY'
import base64, os, secrets
from pathlib import Path
p = Path('deploy/.env')
text = Path('deploy/env.example').read_text().replace(
    'HDU_SNIPER_SECRET_KEY=',
    'HDU_SNIPER_SECRET_KEY=' + base64.b64encode(secrets.token_bytes(32)).decode())
fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as f:
    f.write(text)
print('Created deploy/.env with mode 0600; existing files are never overwritten.')
PY
```

编辑 `deploy/.env`：`HDU_IMAGE` 已预填验收通过的digest；填写可信HTTPS域名 `HDU_ALLOWED_HOSTS`（不带协议/路径）。加密密钥须长期保留并安全备份，不能每次重启重新生成。

P4专用 `deploy/compose.yaml` **强制** `HDU_STRICT_MODE=1 / HDU_STRICT_WRITES=0 / HDU_STRICT_VALIDATED=0`。修改env文件不能打开真实写入。每日模式默认关闭且启用请求会被拒绝；严格模式不启动自动签到，包括旧数据库已保存签到开关的情况。

## 3. 启动（需要服务器操作授权后执行）

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml config -q
docker compose --env-file deploy/.env -f deploy/compose.yaml pull
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
curl --fail http://127.0.0.1:8000/api/health
docker compose --env-file deploy/.env -f deploy/compose.yaml exec hdu-sniper \
  /usr/local/bin/hdu-sniper-server --healthcheck
```

`restart: unless-stopped` 配合开机启用的Docker服务，支持异常退出和主机重启后恢复；手动停止的容器不会意外重启。数据卷默认 `hdu-sniper-v3-data`，包含SQLite任务、审计和敏感会话。stdout日志10MB×3轮转。只读根文件系统，仅数据卷和临时目录可写。

不开放服务器安全组/防火墙8000端口。Compose只监听宿主机 `127.0.0.1`，没有配置公网服务。

## 4. iPad / 安卓安全访问

经用户授权后，服务器、iPad和安卓手机接入同一Tailscale网络；ACL仅允许本人访问。服务器通过Tailscale Serve把私有HTTPS地址转发到回环：

```bash
tailscale serve --bg http://127.0.0.1:8000
```

这是需要另行授权的管理网络开放操作，本次开发不执行。不要启用Funnel；不要把学校登录状态当作管理页面的访问认证。

手机开启Tailscale：iPad用Safari，一加用Chrome或主流浏览器，打开Serve提供的HTTPS地址。首次登录之前先确认域名及HTTPS证书。iPad分别横屏、竖屏检查按钮；安卓窄屏无需左右拖动。

## 5. 分阶段验收（顺序执行）

| 步骤 | 手机操作 / 运维核验 | 通过标准与边界 |
|---|---|---|
|1 Web UI|打开可信HTTPS页面；获校园登录授权后使用原有登录页|登录页可用，敏感输入只发往受信管理服务；遇验证码手动完成，不绕过|
|2 会话|点击“检查登录状态”|显示登录有效、时钟检查通过；仅此时才执行真实只读请求。失败停止，不反复登录|
|3 内部座位ID|获只读预检授权后、当天19:55前点一次“开始”；在19:58后查看准备状态|后台只查询次日已开放数据。管理员用下述只读快照核对四楼宋韵云图的唯一162/157 ID；记录两者不同。禁止从今天state推断后天可用|
|4 日期时段|手机核对自动目标日期；运维核对快照begin/end/opens|上海当天+2，08:00–22:00，14小时，1人；20:00开放。不要通过旧目录API在19:59查询尚未开放的后天|
|5 已有预约|打开“查看预约结果”并与官方记录只读比对|已有重叠预约即停止；不取消、不修改。无法读清记录就停止|
|6 调度|查看“等待20:00 / 准备就绪”，锁屏后再打开；过20:00查看日志|任务由容器执行；P4写入关闭，20:00只会转为“真实写入未授权”终态，**不会预约**。一次无写入演练也会保留该日期任务保护|
|7 次数/接管|检查日志及attempts；点击“停止任务 / 手动接管”|P4真实账户attempts应为空；真实每座最多一次的证明来自合成接口及容器测试，不能冒充真实写入验证。停止不等于取消已有预约|
|8 重启保护|管理员在非抢座窗口重启容器，手机刷新后核对同一日期任务|任务仍在；终态/在途意图不可通过重启重发，审计仍在。生产中严禁插入测试任务或清空表|

完成以上只读验收仍不等于真实预约成功。真实写入需要用户单独明确授权和馆方允许，并使用经过审阅的显式配置变更；本部署包不包含自动开启真实写入的脚本。

### 内部ID和任务的只读快照

现有手机UI显示准备状态，不直接显示内部ID。为避免本阶段修改前端，管理员在**P4真实写入关闭**、19:58准备结束后停止容器，再把数据库复制到权限受限的临时目录，运行：

```bash
umask 077
snapshot_dir=$(mktemp -d)
docker compose --env-file deploy/.env -f deploy/compose.yaml stop
container_id=$(docker compose --env-file deploy/.env -f deploy/compose.yaml ps -aq hdu-sniper)
docker cp "$container_id:/var/lib/hdu-sniper/data/hdu-sniper.sqlite" "$snapshot_dir/state.sqlite"
python3 scripts/v3-inspect-state.py "$snapshot_dir/state.sqlite"
docker compose --env-file deploy/.env -f deploy/compose.yaml start
```

脚本只读SQLite，不联网，不打印UID、Cookie、密码或密钥。它展示持久化证据，不自行重新验证映射或可用性。数据库副本含敏感会话，保存到受限位置并按需要销毁，绝不上传GitHub或发到聊天中。停止/启动期间不能在真实抢座模式演练。

## 6. 备份与回滚

1. 手机点停止任务；管理员停止容器，确认不在19:55–20:10窗口。
2. 备份**最新整个数据卷**，同时在安全位置备份原加密密钥；停止后再复制，避免漏掉WAL中的任务意图。
3. 把 `deploy/.env` 中HDU_IMAGE改成上一个验收通过的严格模式镜像digest；P4写入门禁继续保持0。
4. 运行 `pull`、`up -d` 和健康检查；使用同一卷、同一密钥，核对任务及审计未丢失。

当前若只有一个经过验收的镜像，尚无“前一个合格镜像”可回滚；应停服务并使用官方入口。不要回滚到原通用burst版本，不要恢复写入前的旧数据库，不要运行 `down -v`。镜像标签/digest变更和验收日志均需保留。
