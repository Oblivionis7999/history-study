# V2 部署与运行维护

面向 Ubuntu 24.04 LTS、4 核 4GB、Docker 29、Compose、1Panel v2 / OpenResty。本文提供可审核的部署步骤；开发和 CI 不会自动登录服务器、改 SSH、防火墙、Tailscale、1Panel 或生产数据卷。

## 版本与准备

公开源码位于 [history-study](https://github.com/Oblivionis7999/history-study)，采用 MIT 许可。V1 保留在 `v1.0.0`；V2 分支为 `feature/multi-user-local-first-v2`。部署前选定通过 CI 的明确提交或发布标签并记录 SHA，不使用本地未提交代码上线。

已有 V1 站点应保存原源码版本、`.env`、反向代理配置和一致的学习数据库备份，按 [数据迁移](DATA_MIGRATION.md) 确认记录归属。V2 使用新账号卷，不执行删除数据卷的命令。以下示例用于新目录：

```bash
git clone --branch feature/multi-user-local-first-v2 https://github.com/Oblivionis7999/history-study.git
cd history-study
git rev-parse HEAD
docker version
docker compose version
```

保留已安装的 Docker 环境，不重复运行安装脚本。缺少组件时按 [Docker Ubuntu 指南](https://docs.docker.com/engine/install/ubuntu/)和 [Compose 安装说明](https://docs.docker.com/compose/install/)处理。

## 配置与启动

```bash
cp .env.example .env
chmod 600 .env
```

编辑 `.env`，所有实际密钥只放服务器：

| 变量 | 值或作用 |
|---|---|
| PUBLIC_ORIGIN | 实际 HTTPS 来源，例如 https://study.example.com；与浏览器访问来源一致，不带子路径 |
| PORT | 默认 8080，只绑定 127.0.0.1 |
| SESSION_HOURS | 默认 12 小时 |
| TRUSTED_PROXY_CIDRS | 默认空，仅填已核对的直接可信代理网段 |
| AI_BASE_URL | 供应商兼容接口根地址，程序追加 /chat/completions |
| AI_API_KEY / AI_MODEL | 服务端密钥与有效模型；留空仍可做题，AI 不可用 |
| AI_STREAM | 1 为流式；0 适用于只支持完整响应的接口 |
| AI_USER_PER_MINUTE | 默认 6 |
| AI_USER_DAILY / AI_GLOBAL_DAILY | 默认每账号 80、全站 500 |
| AI_CONCURRENCY / AI_MAX_TOKENS | 默认全站并发 3、输出 1800 tokens |

Compose 强制 `DEV_MODE=0`。V2 不使用 V1 共享密码、`ACCESS_PASSWORD_HASH` 或 `SESSION_SECRET`。AI 每日默认值用于初始化设置，管理员保存后以数据库设置为准；接口、密钥、频率、并发等环境配置变更后需重建 API 容器。

```bash
docker compose config --quiet
docker compose build
docker compose run --rm --no-deps api python -m backend.accounts create-admin --username admin
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:8080/api/health
```

管理员命令交互输入密码，至少 12 字符，没有通用初始密码。健康接口应返回 `ok: true` 和 `bank_count: 700`。管理员登录并建立本机空间后，可以创建普通账号或邀请码。

网页只发布 `127.0.0.1:8080`，FastAPI 不发布宿主端口。API 以 UID 10001 非 root、单 Uvicorn worker 运行，账号卷挂载到 `/app/.runtime`。AI 并发保护包含进程内状态，应维持单 worker。API 内存上限 768MB、网页 128MB，各保留 3 份 10MB 日志；构建另需临时内存。这些是配置预算，实际 4GB 服务器峰值和长期运行未测。

## 1Panel、OpenResty 与 HTTPS

在现有 1Panel 网站配置 HTTPS 反向代理，指向宿主机本地 8080。参考 `deploy/host-nginx.conf.example`，替换域名、证书和路径，保留 Host，正确覆盖来源地址头，并关闭代理缓冲与缓存以支持 AI SSE。

先核对 OpenResty 网络方式：独立网络容器的 `127.0.0.1` 指向容器自身。应按现有面板方案配置可达上游，不直接把 8080 暴露到公网。面板步骤参考 [1Panel v2 网站配置](https://1panel.pro/docs/v2/user_manual/websites/website_config_basic/)。

通过有效 HTTPS 域名登录，生产 Cookie 使用 Secure。学习备份在浏览器本地解析，不需要扩大服务端请求体上限来上传备份。外层代理应保留内层 CSP、安全头和 Service Worker 更新响应头。上线验收同时检查登录、Origin、Cookie、AI 流与错误提示，不能只验证健康接口。

默认应用不信任外来代理 IP 头。只有核对代理网络和头链路后才配置 `TRUSTED_PROXY_CIDRS`，不信任全部地址；外层代理要覆盖访客可伪造的来源头。共享出口下仍有较高 IP 总限额，具体规则见 [账号安全](ACCOUNT_SECURITY.md)。

## 未来接入 Cloudflare

采用 [Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)，源站配置匹配域名的有效证书。对 `/api/*`、登录响应及 `sw.js` 绕过缓存，不使用覆盖全站的 Cache Everything，不记录敏感请求体。

需要真实访客 IP 时，先在外层核验 Cloudflare 官方当前地址范围并建立可信代理链，再配置应用。当前未改动生产 Cloudflare、1Panel 或证书配置。

## 备份与恢复

默认身份卷为 `history-study_account-data`，包括账号库和 `account-backups`。API 每天北京时间 03:00 后备份一次，保留最近 7 份；当天 03:00 后启动会补做。数据库和备份同卷，维护者需另行保存异机副本。

```bash
docker compose exec api python -m backend.accounts backup
docker compose logs --tail=100 api
```

账号备份包含密码哈希和权限等敏感信息，不得公开。用户学习记录不在此卷，需各自从浏览器导出加密备份并保存恢复密钥。

账号库灾难恢复仅在已授权维护窗口执行。先停止 API，列出备份，再填写列出的真实文件名：

```bash
docker compose stop api
docker compose run --rm --no-deps api python -m backend.restore_accounts --list
docker compose run --rm --no-deps api python -m backend.restore_accounts 选定的accounts备份文件.sqlite --confirm-stopped
docker compose up -d api
```

工具检查 SQLite 完整性、身份表结构及有效管理员，保存当前数据库与 WAL/SHM 后替换，撤销全部旧 Session。恢复只包含备份时刻的账号，新近创建用户的 UUID 需另行核对；同名重建不是恢复原身份。

## 更新、回退与验证

更新前备份账号库和配置，提醒用户导出本机记录。取得已确认代码后执行 `docker compose up -d --build`。正常停止或重建保留卷；不要执行 `down -v`。

Service Worker 只缓存静态资源，用户确认更新后重新解锁。不要用清除网站存储解决普通更新。更换域名、端口或协议前先导出，因为浏览器将其视为不同来源。

V1 回退使用独立目录 `v1.0.0` 源码、原配置和原学习卷；不能给 V1 挂载账号库。V2 新学习记录不自动写回 V1。完整边界见 [迁移指南](DATA_MIGRATION.md)。

隔离 GitHub Actions 检查 Compose config/build、启动健康、HTTPS Secure Cookie、多账号权限、题库、模拟 AI 及重启持久化。脚本只允许一次性 CI 环境，拒绝覆盖已有 `.env`，清理范围固定为临时 `study-v2-ci` 项目。最终结果见 [TEST_REPORT.md](TEST_REPORT.md)。

目标服务器部署、真实证书/域名、1Panel 网络、Cloudflare、真实 AI 和负载表现为 NOT TESTED，获准上线后再实际验证。
