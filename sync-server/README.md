# Beayy Cloudflare 同步服务（免费自托管）

这里只实现 **Beayy 多设备同步**。默认开放免费注册，不需要 Beayy 付费账号、邀请码、Cloudflare API Token、信用卡或自定义域名。

## 推荐方式：Cloudflare 直接连接 GitHub 自动部署

不用下载代码、不用安装 Node.js，也不用打开终端。首次连接 GitHub 后，Cloudflare 会在你推送代码时自动重新部署。

### 1. 准备账号

准备一个免费的 [Cloudflare 账号](https://dash.cloudflare.com/sign-up) 和 GitHub 账号，并确认你能访问 [Beayy 仓库](https://github.com/ajiangstudy/beayy)。

### 2. 在 Cloudflare 导入仓库

打开 [Cloudflare Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages)，按下面顺序操作：

1. 点击 **Create application**。
2. 选择 **Connect to Git**（或 GitHub）。
3. 第一次使用时，按提示授权 Cloudflare 访问 GitHub。
4. 选择仓库 `ajiangstudy/beayy`。
5. 选择分支 `feat/cloudflare-sync-only`。这是目前包含 Cloudflare 同步后端的分支；PR 合并到主分支后，可以把这里改成 `main`。

### 3. 填写构建设置

这是一个 monorepo，务必把 Root directory 设置为 `sync-server`。其余按下表填写：

| Cloudflare 设置 | 填写内容 |
|---|---|
| Worker name / Project name | `beayy-sync-selfhosted` |
| Production branch | `feat/cloudflare-sync-only` |
| Root directory | `sync-server` |
| Build command | 留空 |
| Deploy command | `npm run deploy` |

然后点击 **Save and Deploy**。

> Worker 名称必须是 `beayy-sync-selfhosted`，要与 `wrangler.jsonc` 中的 name 完全一致，否则部署会失败。不要改成其他名称。

### 4. 等待 Cloudflare 显示部署成功

Cloudflare 会从 GitHub 拉取代码，并自动安装项目中的 Wrangler。部署脚本会依次：

1. 发布 Worker，并按配置自动创建 D1 数据库和 SQLite Durable Objects 命名空间。
2. 初始化 D1 数据表。
3. 输出部署结果和 `workers.dev` 访问地址。

Cloudflare Git 集成会自动管理部署所需的凭据，不需要自己创建 API Token、填写数据库 ID 或上传密钥。也不需要添加信用卡。

### 5. 把地址填入 Beayy

在 Cloudflare Worker 的 Overview 页面找到域名，地址类似：

```text
https://beayy-sync-selfhosted.<你的子域>.workers.dev
```

先在浏览器打开：

```text
https://beayy-sync-selfhosted.<你的子域>.workers.dev/v2/health
```

看到 `{"ok":true}` 就表示服务已能响应。然后打开 Beayy「设置 → 连接 → 同步服务器」，填入 Worker 根地址（不要在末尾加 `/v2/health`），保存后注册／登录即可。

## 以后如何更新

Cloudflare 会监听你选择的 GitHub 分支。代码有更新并推送到该分支后，就会自动重新构建和部署，无需再次手动操作。

当前使用的是 `feat/cloudflare-sync-only` 分支。等这个分支的 PR 合并到 `main` 后，在 Cloudflare Worker 的 **Settings → Builds** 中把 Production branch 改为 `main` 即可。

## 可选：本地命令行部署

如果不想使用 GitHub 集成，也可以在电脑安装 Node.js 20+，下载仓库并进入 `sync-server`，运行：

```bash
npm run deploy:local
```

首次运行会打开 Cloudflare 登录页。这个本地备用入口不影响上面的 GitHub 自动部署。

## 为什么不用 R2

本版不绑定 R2。为了让免费部署不需要支付方式，数据块改为存放在 SQLite-backed Durable Objects。D1 只保存账号、设备会话和块索引。每个账号使用独立的 Durable Object，互相隔离。

每个数据块最大 50 MiB，Durable Object 内部按 1.8 MB 分块存入 SQLite（低于 Cloudflare 2 MB 的单行上限）。上传仍是客户端已经压缩并端到端加密的密文，服务端没有解密密钥。客户端可以原样上传录音、地点、健康和摘要等同步块；服务端不会运行转写、地图或模型，也不会定时清理同步数据。

## 免费额度与边界

本方案只用 Cloudflare Workers Free、D1 Free 和 SQLite Durable Objects Free，不启用任何付费服务或按量付费项目。按目前官方免费额度，Workers 为每天 100,000 次请求、每次 10 ms CPU；D1 为每天 500 万行读取、10 万行写入，每个数据库 500 MB；SQLite Durable Objects 为每个 Cloudflare 账户合计 5 GB 存储、每天 100,000 次请求、5,000 万行读取和 10 万行写入。额度可能由 Cloudflare 调整，部署前请以官方价格和限额页面为准。超过 Free 额度时，相关操作会报错／暂停，不会在 Free 计划上自动升级或自动扣费。请勿在 Cloudflare 控制台升级到 Workers Paid。

建议把这套方案用于个人或小规模自托管。免费 DO 存储额度是 Cloudflare 账户级共享额度，不是每个 Beayy 用户各有 5 GB；开放注册的所有用户共用部署者的免费存储池。

## 注册方式

默认 `OPEN_SIGNUP` 为 `true`，任何知道服务地址的人都能注册，不要求邀请码。若只给自己和家人使用，把 `wrangler.jsonc` 的 `vars.OPEN_SIGNUP` 改成 `"false"`，再把改动推送到 GitHub 分支重新部署，并在 Cloudflare Worker 的 Settings → Variables and Secrets 中配置 `INVITE` secret。

开放注册时请注意：服务地址公开后，其他人也可以创建账号并使用你的免费存储池。

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
