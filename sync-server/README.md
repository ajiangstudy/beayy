# Beayy Cloudflare 同步服务（免费自托管）

这里只实现 **Beayy 多设备同步**。默认开放免费注册，不需要 Beayy 付费账号、邀请码、Cloudflare API Token、信用卡或自定义域名。

## 一条命令部署

准备一个免费的 Cloudflare 账号，并安装 Node.js 20 或更新的 LTS 版本。下载仓库后：

```bash
cd sync-server
npm run deploy
```

第一次运行会自动打开 Cloudflare 登录页面。登录后脚本会自动创建并绑定 D1、创建 SQLite Durable Object 命名空间、初始化数据库并部署 Worker；不需要手动创建资源、复制 database_id、填写密钥或配置 DNS。部署完成后 Wrangler 会显示一个 `https://....workers.dev` 地址，把它填进 Beayy「设置 → 连接 → 同步服务器」。

Windows、macOS、Linux 都可以运行同一条命令。脚本使用固定版本的 Wrangler，避免不同电脑上的 CLI 版本不一致。

## 为什么不用 R2

本版不绑定 R2。Cloudflare 的 R2 开通流程需要先添加 R2 subscription 并走 checkout；为了让免费部署不碰支付信息，数据块改为存放在 SQLite-backed Durable Objects。D1 只保存账号、设备会话和块索引。每个账号使用独立的 Durable Object，互相隔离。

每个数据块最大 50 MiB，Durable Object 内部按 1.8 MB 分块存入 SQLite（低于 Cloudflare 2 MB 的单行上限）。上传仍是客户端已经压缩并端到端加密的密文，服务端没有解密密钥。客户端可以原样上传录音、地点、健康和摘要等同步块；服务端不会运行转写、地图或模型，也不会定时清理同步数据。

## 免费额度与边界

本方案只用 Cloudflare Workers Free、D1 Free 和 SQLite Durable Objects Free，不启用任何付费服务或按量付费项目。Cloudflare 免费额度不是无限量：Workers 每天有请求和 CPU 限额；D1 每天有读写限额；SQLite Durable Objects 的免费账户存储合计为 5 GB，并有每日请求、SQL 读写和计算时长额度。超过免费额度时，相关操作会报错／暂停，而不是自动升级套餐或自动扣费。请勿在 Cloudflare 控制台升级到 Workers Paid。

建议把这套方案用于个人或小规模自托管。免费 DO 存储额度是 Cloudflare 账户级共享额度，不是每个 Beayy 用户各有 5 GB；开放注册的所有用户共用部署者的免费存储池。

## 注册方式

默认 `OPEN_SIGNUP` 为 `true`，任何知道服务地址的人都能免费注册，不要求邀请码。若只给自己和家人使用，把 `wrangler.jsonc` 的 `vars.OPEN_SIGNUP` 改成 `"false"`，然后设置邀请码：

```bash
npx wrangler@4.45.0 secret put INVITE
npm run deploy
```

开放注册适合私人部署时要注意：服务地址公开后，其他人也可以创建账号并使用你的免费存储池。

## 数据与备份

- D1：账号、登录会话、数据块索引（`schema.sql`）。
- Durable Objects：每个用户自己的 SQLite 数据库，保存该用户的加密数据块。
- 不保存模型、转写或地图配置；这些功能留作以后独立扩展。
- 请定期备份 D1，并通过 Cloudflare Durable Objects 的 SQLite 备份／恢复能力维护数据。同步服务不是客户端本地数据的唯一副本。

## 协议

接口沿用 Beayy 客户端协议：

- `GET /v2/signup`、`GET /v2/prelogin?email=...`
- `POST /v2/register`、`POST /v2/login`、`POST /v2/recover`
- `POST /v2/claim`（旧 v1 账号迁移）、`POST /v2/password`
- `GET /v2/account`、`POST /v2/profile`、`DELETE /v2/sessions/{id}`
- `POST /v1/register`（旧令牌注册）、`PUT/GET/DELETE /v1/blob/{device}/{segment}`
- `GET /v1/list`（支持 `since`、`prefix`、`device`）、`GET /v1/usage`、`GET /v1/devices`、`DELETE /v1/account`
- `GET /v2/health`

需要认证的接口沿用 `Authorization: Bearer <user>:<token>`。
