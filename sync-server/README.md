# Beayy Cloudflare 同步服务（自托管）

这里只实现 **Beayy 多设备同步**。Worker 提供账号注册／登录、设备会话管理、加密数据块上传／下载／删除、增量列表和存储用量统计。D1 保存账号与索引，R2 保存客户端已经压缩、端到端加密的数据块；服务器不持有解密密钥。

本目录不部署模型、FunASR、转写任务、地图代理、LLM 网关、Queues 或 Durable Objects。这些都不属于同步服务，留作以后独立扩展。录音、地点、健康、摘要等客户端数据如以普通同步块上传，仍由通用 blob 接口原样存储，不会在服务器端处理或自动过期。

## 资源

- Cloudflare Worker：worker.js
- D1 初始化：schema.sql
- R2：保存 `<user>/<device>/<segment>` 对应的密文对象
- D1：保存用户、设备会话，以及每个 blob 的大小和更新时间

每个 blob 最大 50 MiB。当前版本每个账号不设容量上限（/v2/account 返回 storage.quota: 0，表示不限额）。同步块不会由 Worker 定时删除；只有客户端主动 DELETE 或用户删除账号时才清除。

## 部署

需要 Cloudflare 账号、Node.js 和 Wrangler 4。

```bash
cd sync-server
npx wrangler@4 login

# 创建独立资源，不要把旧官方实例的 D1 ID 或生产 bucket 复用到自托管实例
npx wrangler@4 r2 bucket create beayy-sync-selfhosted
npx wrangler@4 d1 create beayy-sync-selfhosted
```

把 D1 创建命令返回的 UUID 填到 wrangler.jsonc 的 d1_databases[0].database_id，再初始化数据库：

```bash
npx wrangler@4 d1 execute beayy-sync-selfhosted --remote --file=./schema.sql
```

默认使用邀请码注册。设置一个只有你知道的高强度邀请码：

```bash
npx wrangler@4 secret put INVITE
```

也可以在 wrangler.jsonc 的 vars.OPEN_SIGNUP 改成 "true" 开放注册；开放注册时不需要配置 INVITE。

部署：

```bash
npx wrangler@4 deploy
```

Wrangler 会给出 workers.dev 访问地址。把这个 HTTPS 地址填到 Beayy 的「设置 → 连接 → 同步服务器」及注册／登录界面。需要自定义域名时，在 Cloudflare 控制台给该 Worker 添加自己的 Custom Domain；本配置不会绑定 sync.beayy.com，也不会连接仓库旧配置中的 D1 数据库 ID。

## API

接口沿用现有 Beayy 客户端协议：

- GET /v2/signup、GET /v2/prelogin?email=...
- POST /v2/register、POST /v2/login、POST /v2/recover
- POST /v2/claim（旧 v1 账号迁移）、POST /v2/password
- GET /v2/account、POST /v2/profile、DELETE /v2/sessions/{id}
- POST /v1/register（旧令牌注册）、PUT/GET/DELETE /v1/blob/{device}/{segment}
- GET /v1/list（支持 since、prefix、device）、GET /v1/usage、GET /v1/devices、DELETE /v1/account
- GET /v2/health

需要认证的接口沿用 Authorization: Bearer <user>:<token>。数据块按用户隔离，R2 key 不接受客户端自定义路径，设备名／块名会先校验。

## 数据与迁移说明

客户端才持有主密码、恢复码和数据密钥。D1 中的 auth_hash、recovery_hash 是派生校验值的 SHA-256；wrapped_key 是客户端包好的数据密钥；R2 内容是密文。请同时备份 D1 和 R2，缺少任意一方都可能导致同步索引或对象无法恢复。

本版 schema 是新建自托管实例用的精简结构。已有旧 Cloudflare 同步实例的 D1 表可能包含模型／地图的历史字段；Worker 不再读写这些字段，执行本文件不会删除现有数据或字段。不要对已有生产库直接重建或清空。
