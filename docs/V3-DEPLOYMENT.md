# V3 云端部署、手机使用与回滚

本分支是离线开发交付。没有真实账号登录、真实预约、已有预约取消或公网发布。Codex Cloud 不是常驻预约服务器。

## 获取本次代码

本地分支 `feat/cloud-strict-v3`。当前Git身份无上游写权限，远端推送返回403，未创建PR；交付附带增量Git bundle及补丁。已有上游仓库可导入：

```bash
git fetch /path/to/HDU-Library-Sniper-v3.bundle feat/cloud-strict-v3:feat/cloud-strict-v3
git switch feat/cloud-strict-v3
```

bundle依赖基线 `46ccd4739f5cd14b30bb271fd8d7076903577b50`，新机器先clone原仓库。随后由具备写权限的账号推送该分支或推到自己的fork发起PR，不合并未经审查的改动。

## 从提交到服务器

1. 审阅开发分支与 [审计说明](V3-AUDIT.md)、[验收清单](V3-VALIDATION.md)。使用自己的常驻 Linux 主机，不需要为本次开发购买服务器。
2. 在服务器检出审阅通过的**固定提交**；先完成 CI 和容器构建。启用 Docker 服务开机启动。Podman 使用项目已有 systemd 脚本；rootless 部署需配置 user unit/linger。
3. 配置 NTP。执行 `timedatectl status` 或 `chronyc tracking`，确认已同步；确保服务器能合法访问学校慧图服务。不要使用代理绕过馆方访问限制。
4. 在仓库目录准备未跟踪配置：

```bash
cp .env.example .env.local
chmod 600 .env.local
openssl rand -base64 32
```

将生成值填入 `HDU_SNIPER_SECRET_KEY`，不粘贴到日志、工单或提交中。密钥应安全备份且重启保持不变。设置：

```dotenv
HDU_STRICT_MODE=1
HDU_STRICT_WRITES=0
HDU_STRICT_VALIDATED=0
HDU_ALLOWED_HOSTS=你的主机名.你的tailnet.ts.net
```

5. 构建并启动（执行这些步骤意味着部署，当前开发环境未执行生产部署）：

```bash
docker compose --env-file .env.local build
docker compose --env-file .env.local up -d
docker compose ps
docker compose exec hdu-sniper /usr/local/bin/hdu-sniper-server --healthcheck
docker compose logs --tail=100 hdu-sniper
```

始终带 `--env-file .env.local`：它也用于 Compose 的变量插值。Compose 默认只发布 `127.0.0.1:8000`，并设置 `restart: always`。命名卷持久化 SQLite、任务意图和审计；stdout日志按10MB×3轮转。任务日志保存在卷内，容器替换后仍可读取。只允许**一个受信账号、一套数据卷**；多进程必须共用同一卷，复制数据库成两个实例无法共享幂等保护。

Podman 可按原项目 `scripts/podman-build.sh`、`scripts/podman-up.sh` 操作；本分支启动脚本默认回环监听，读取 `.env.local`。或手工使用固定镜像：

```bash
podman run -d --name hdu-library-sniper --restart=always \
  --env-file .env.local -e HDU_STRICT_MODE=1 \
  -p 127.0.0.1:8000:8000 \
  -v hdu-sniper-data:/var/lib/hdu-sniper:Z \
  localhost/hdu-library-sniper:dev
```

## 安全访问（执行前需用户授权）

管理服务是单租户，学校登录状态不等同于管理页面的访问认证。不能直接发布到公网，也不能只依赖 Host/Origin 守卫。

建议服务器和手机/iPad加入同一个 Tailscale 网络，用 ACL 只允许该用户访问，并通过 **Tailscale Serve HTTPS** 转发到回环地址。经授权后在服务器配置：

```bash
tailscale serve --bg http://127.0.0.1:8000
```

不要启用 Funnel，不开放安全组8000端口。域名必须加入 `HDU_ALLOWED_HOSTS`；HTTPS才能安全传送首次登录凭据。首次登录需用户另行授权，通过可信管理页使用现有登录流程；遇学校验证码/访问限制则停下手动认证。

凭据采用原项目 AES-GCM；Cookie 仍由原项目保存在数据库中，因此数据卷和备份都必须按敏感数据保护，禁止提交。严格服务器缺失有效加密密钥会拒绝启动。

## 一加与 iPad

- 一加：打开Tailscale连接，再用Chrome/系统主流浏览器打开HTTPS管理地址。
- iPad：连接Tailscale，用Safari打开同一地址；可添加到主屏幕。支持横屏和竖屏。
- 登录后“预约方案”页显示固定目标，无需填日期、时间、人数和座位。
- 点“一键开始抢座”：20:00前待命；之后在当天合法窗口内准备并执行。重复点击显示原任务，不创建第二次任务。
- “取消待命 / 停止任务”和“手动接管”会关闭每日模式，不取消已有预约。已发出的请求可能仍完成，请看官方记录。
- 两座均失败显示“自动抢座已停止，请手动选择其他座位。”，点官方入口手动处理。
- 浏览器关闭、手机断网或锁屏不影响服务器。UI刷新仅读取后台任务状态，不驱动预约。
- 真实验收完成后才能打开每日开关。后台按北京时间19:55检查、19:58准备、20:00之后执行。

## 两阶段上线

第一阶段保持 WRITES=0 / VALIDATED=0。必须先通过本地测试、构建、NTP、回环健康和安全访问检查；真实凭据只读检查仍需用户授权。

第二阶段在用户明确授权且馆方允许时，仅选择一次合法时段测试。本固定方案仅支持当日+2的08:00–22:00，不提供任意测试时段配置。若用户授权的测试时段不同，先修改经审查的测试策略，不能自行占用座位。

1. 先登录并只读核对 UID、四楼区域、162/157内部ID、时段限制和已有预约。
2. 用户确认没有时段冲突后，设置 WRITES=1、VALIDATED=0 并重建容器（不重建数据库）。
3. 点击一次开始；若该目标已在无写入验收中被关闭，**不删除记录重跑**，选择下一天的新目标。UNKNOWN任务永远不可重置。
4. 核对官方预约记录及审计，不能为测试连续取消/重订。
5. 真实测试通过、规则允许后，记录验收证据，设置 VALIDATED=1、保留WRITES=1，用户再打开每日开关。该环境变量只是运维验收门禁，程序不会伪造验证结果。

## 故障及回滚

- UNKNOWN/HTTP404/超时：先看官方预约记录，禁止用重启、清库、改座位参数补发。请求失败不等于未落单。
- LIMITED：立即停止，保留审计，不自动等待10分钟后继续写。
- AUTH_REQUIRED：重新登录并检查时钟；同一终止任务不重开，可预约新日期或官方手动处理。
- 映射失效：先只读核验馆方目录变化，再修正契约，不能手填猜测ID。
- 中断任务不自动重新认领；查看官方记录，保持保护记录。

回滚步骤：在管理页停止任务，停容器，**离线备份当前整个数据卷（含WAL）与加密密钥**，然后切到上一个已验证的严格模式提交/镜像；重新启动前保留当前任务表。不要恢复预约写之前的旧数据库。新增任务表是加法迁移；旧版本虽然能读原表，但不认识严格保护，所以不可启用旧 burst 调度。紧急情况下停服务，用户手动使用官方入口最稳妥。不要执行 `compose down -v`。

自动镜像更新不适合19:55–20:10窗口；上线前固定版本并关闭原项目自动拉 latest 的更新计时器，避免替换到未审阅的通用调度版本。
