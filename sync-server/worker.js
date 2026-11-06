// Beayy Cloudflare 纯同步服务：只存客户端加密好的数据块，服务器读不到内容。
// 协议见 报告/方案_20261016_多设备同步.md。R2 存密文，D1 存账号（令牌只存哈希）和「哪个块什么时候更新过」的索引。
//
// v2 账号：邮箱＋主密码。主密码只在设备上用，派生出两把：登录校验值（服务器只存它的哈希）和包数据密钥的钥匙
// （服务器只存包好的数据密钥，解不开）。每台设备登录后拿自己的令牌，可单独移除。另有恢复码，忘了主密码时重设。

const NAME = /^[\p{L}\p{N}._-]{1,80}$/u;
const MAX_BLOB = 50 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;
/** 设备上主密码派生用的参数（Argon2id）；服务器只是原样存取 */
const KDF = { alg: "argon2id", m: 65536, t: 3, p: 1 };


export default { async fetch(req, env) { try { return await route(req, env); } catch (e) { return json({ error: String(e && e.message ? e.message : e) }, 500); } } };

function userBlobStore(env, user) {
  const id = env.BLOBS.idFromName(user);
  return env.BLOBS.get(id);
}

/**
 * 每个账号独立一个 SQLite Durable Object，只存客户端上传的加密块。
 * 单条 BLOB 保持在 2 MB 行上限以内；分块上传与下载兼容 50 MiB 的客户端块。
 */
export class BeayyBlobStore {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS blob_objects (device TEXT NOT NULL, segment TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (device, segment))",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS blob_chunks (device TEXT NOT NULL, segment TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (device, segment, part))",
    );
  }

  async fetch(req) {
    try {
      const url = new URL(req.url);
      let p;
      try { p = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part)); }
      catch (_e) { return json({ error: "路径不合法" }, 400); }

      if (p[0] === "account" && req.method === "DELETE") {
        this.ctx.storage.transactionSync(() => {
          this.sql.exec("DELETE FROM blob_chunks");
          this.sql.exec("DELETE FROM blob_objects");
        });
        return json({ ok: true });
      }

      if (p[0] !== "blob" || p.length !== 3) return json({ error: "没有这个接口" }, 404);
      const device = p[1], segment = p[2];
      if (!NAME.test(device) || !NAME.test(segment)) return json({ error: "设备名或分段名不合法" }, 400);

      if (req.method === "PUT") {
        const body = await req.arrayBuffer();
        if (body.byteLength > MAX_BLOB) return json({ error: "太大了" }, 413);
        // SQLite-backed Durable Objects 的 BLOB/行大小上限是 2 MB；预留空间后使用 1.8 MB 分块。
        const chunkSize = 1_800_000;
        const count = Math.ceil(body.byteLength / chunkSize);
        this.ctx.storage.transactionSync(() => {
          this.sql.exec("DELETE FROM blob_chunks WHERE device = ? AND segment = ?", device, segment);
          for (let part = 0; part < count; part++) {
            const start = part * chunkSize;
            const chunk = body.slice(start, Math.min(start + chunkSize, body.byteLength));
            this.sql.exec(
              "INSERT INTO blob_chunks (device, segment, part, data) VALUES (?, ?, ?, ?)",
              device, segment, part, chunk,
            );
          }
          this.sql.exec(
            "INSERT INTO blob_objects (device, segment, size) VALUES (?, ?, ?) ON CONFLICT (device, segment) DO UPDATE SET size = excluded.size",
            device, segment, body.byteLength,
          );
        });
        return json({ ok: true, size: body.byteLength });
      }

      if (req.method === "GET") {
        const meta = this.sql.exec(
          "SELECT size FROM blob_objects WHERE device = ? AND segment = ?",
          device, segment,
        ).toArray()[0];
        if (!meta) return json({ error: "没有这个块" }, 404);

        // 在任何 await 之前一次性读完游标，避免并发覆盖时读取到不一致的半新半旧块。
        const rows = this.sql.exec(
          "SELECT data FROM blob_chunks WHERE device = ? AND segment = ? ORDER BY part",
          device, segment,
        ).toArray();
        const expected = Math.ceil(meta.size / 1_800_000);
        if (rows.length !== expected) return json({ error: "数据块不完整" }, 500);
        const chunks = rows.map((row) => row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data));
        let index = 0;
        const stream = new ReadableStream({
          pull(controller) {
            if (index >= chunks.length) return controller.close();
            controller.enqueue(chunks[index++]);
          },
        });
        return new Response(stream, { headers: { "content-type": "application/octet-stream" } });
      }

      if (req.method === "DELETE") {
        this.ctx.storage.transactionSync(() => {
          this.sql.exec("DELETE FROM blob_chunks WHERE device = ? AND segment = ?", device, segment);
          this.sql.exec("DELETE FROM blob_objects WHERE device = ? AND segment = ?", device, segment);
        });
        return json({ ok: true });
      }
      return json({ error: "不支持这个方法" }, 405);
    } catch (e) {
      return json({ error: String(e && e.message ? e.message : e) }, 500);
    }
  }
}

/** 块的种类：按块名前缀（分段名以年份开头） */
function kindOf(device, segment) {
  if (device === "account") return "account";
  for (const k of ["audio", "transcript", "places", "health", "daily", "sum"]) if (segment.startsWith(k + ".")) return k === "sum" ? "summary" : k;
  return segment === "names.json" ? "account" : "segment";
}

async function route(req, env) {
  const url = new URL(req.url);
  let p;
  try { p = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part)); }
  catch (_e) { return json({ error: "路径不合法" }, 400); }
  if (p[0] === "v2" && p[1] === "health" && req.method === "GET") return json({ ok: true });
  if (p[0] === "v2") return v2(req, env, p.slice(1), url);
  if (p[0] !== "v1") return json({ error: "没有这个接口" }, 404);

  if (p[1] === "register" && req.method === "POST") {
    const open = env.OPEN_SIGNUP === "1" || env.OPEN_SIGNUP === "true";
    const invite = req.headers.get("x-invite") || "";
    if (!open && (!env.INVITE || !(await same(invite, env.INVITE)))) return json({ error: "邀请码不对" }, 403);
    const user = hex(rand(12));
    const token = hex(rand(32));
    await env.DB.prepare("INSERT INTO users (user, token_hash, created) VALUES (?, ?, ?)").bind(user, await sha256(token), Date.now()).run();
    return json({ user, token });
  }

  const who = await auth(req, env);
  if (!who) return json({ error: "没登录或令牌不对" }, 401);
  const user = who.user;

  if (p[1] === "blob" && p.length === 4) {
    const [device, segment] = [p[2], p[3]];
    if (!NAME.test(device) || !NAME.test(segment)) return json({ error: "设备名或分段名不合法" }, 400);
    const store = userBlobStore(env, user);
    const objectUrl = `https://blob.internal/blob/${encodeURIComponent(device)}/${encodeURIComponent(segment)}`;
    if (req.method === "PUT") {
      // 音频等大块直接流入该用户自己的 Durable Object，不经过 D1，也不需要 R2。
      const saved = await store.fetch(new Request(objectUrl, { method: "PUT", body: req.body }));
      if (!saved.ok) return saved;
      const info = await saved.json();
      const size = Number(info.size);
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BLOB) return json({ error: "存储结果不合法" }, 500);
      const now = Date.now();
      await env.DB.prepare(
        "INSERT INTO blobs (user, device, segment, size, updated) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT (user, device, segment) DO UPDATE SET size = excluded.size, updated = excluded.updated",
      ).bind(user, device, segment, size, now).run();
      return json({ updated: now });
    }
    if (req.method === "GET") {
      return store.fetch(new Request(objectUrl, { method: "GET" }));
    }
    if (req.method === "DELETE") {
      const removed = await store.fetch(new Request(objectUrl, { method: "DELETE" }));
      if (!removed.ok) return removed;
      await env.DB.prepare("DELETE FROM blobs WHERE user = ? AND device = ? AND segment = ?").bind(user, device, segment).run();
      return json({ ok: true });
    }
  }

  if (p[1] === "list" && req.method === "GET") {
    const since = Number(url.searchParams.get("since") || 0) || 0;
    // 可按块名前缀（transcript.、audio.、places.）和设备筛
    const prefix = url.searchParams.get("prefix") || "";
    const device = url.searchParams.get("device") || "";
    if ((prefix && !/^[A-Za-z0-9._-]{1,40}$/.test(prefix)) || (device && !NAME.test(device))) return json({ error: "筛选条件不合法" }, 400);
    // 索引写明：从头按前缀列（0.2.19 及以前的客户端每轮都这样）走 (user, segment)，只读这一类；增量列走 (user, updated)，只读新来的。
    // D1 按读到的行计费，交给查询规划自己挑时两种都会挑错
    const index = prefix && !since ? "blobs_seg" : "blobs_updated";
    let sql = `SELECT device, segment, size, updated FROM blobs INDEXED BY ${index} WHERE user = ? AND updated > ?`;
    const args = [user, since];
    if (prefix) { sql += " AND segment >= ? AND segment < ?"; args.push(prefix, prefix + "\uffff"); }
    if (device) { sql += " AND device = ?"; args.push(device); }
    const { results } = await env.DB.prepare(sql + " ORDER BY updated LIMIT 5000").bind(...args).all();
    return json({ items: results, now: Date.now() });
  }

  // 这个账号在服务器上存了什么：按设备和种类合计（设置「数据」页用）
  if (p[1] === "usage" && req.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT device, segment, size, updated FROM blobs WHERE user = ?",
    ).bind(user).all();
    const m = new Map();
    for (const r of results) {
      const k = `${r.device}\u0000${kindOf(r.device, r.segment)}`;
      const x = m.get(k) || { device: r.device, kind: kindOf(r.device, r.segment), count: 0, bytes: 0, oldest: r.updated, newest: r.updated };
      x.count++; x.bytes += r.size; x.oldest = Math.min(x.oldest, r.updated); x.newest = Math.max(x.newest, r.updated);
      m.set(k, x);
    }
    return json({ items: [...m.values()], now: Date.now() });
  }

  if (p[1] === "devices" && req.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT device, COUNT(*) AS segments, SUM(size) AS bytes, MAX(updated) AS updated FROM blobs WHERE user = ? GROUP BY device ORDER BY device",
    ).bind(user).all();
    return json({ devices: results });
  }

  if (p[1] === "account" && req.method === "DELETE") {
    // 每个账号的数据块放在各自的 Durable Object 中，删除账号时一并清空。
    const removed = await userBlobStore(env, user).fetch(new Request("https://blob.internal/account", { method: "DELETE" }));
    if (!removed.ok) return removed;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM blobs WHERE user = ?").bind(user),
      env.DB.prepare("DELETE FROM sessions WHERE user = ?").bind(user),
      env.DB.prepare("DELETE FROM users WHERE user = ?").bind(user),
    ]);
    return json({ ok: true });
  }
  return json({ error: "没有这个接口" }, 404);
}

/** Authorization: Bearer <user>:<token> → {user, session}。令牌可以是设备登录的（sessions），也可以是 v1 共用令牌 */
async function auth(req, env) {
  const m = (req.headers.get("authorization") || "").match(/^Bearer ([0-9a-f]{24}):([0-9a-f]{64})$/);
  if (!m) return null;
  const h = await sha256(m[2]);
  const s = await env.DB.prepare("SELECT id, last_seen FROM sessions WHERE user = ? AND token_hash = ?").bind(m[1], h).first();
  if (s) {
    if (Date.now() - s.last_seen > 3600e3) await env.DB.prepare("UPDATE sessions SET last_seen = ? WHERE id = ?").bind(Date.now(), s.id).run();
    return { user: m[1], session: s.id };
  }
  const row = await env.DB.prepare("SELECT token_hash FROM users WHERE user = ?").bind(m[1]).first();
  if (!row) return null;
  return (await same(h, row.token_hash)) ? { user: m[1], session: null } : null;
}

// ---------- v2：账号 ----------

async function body(req) {
  try {
    const value = await req.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (_e) {
    return {};
  }
}

/** 这台设备登录：发一个设备令牌 */
async function newSession(env, user, name, device) {
  const id = hex(rand(8));
  const token = hex(rand(32));
  const now = Date.now();
  await env.DB.prepare("INSERT INTO sessions (id, user, name, device, token_hash, created, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, user, String(name || "").slice(0, 80), String(device || "").slice(0, 80), await sha256(token), now, now).run();
  return { session: id, token };
}

function credsOk(b) {
  return typeof b.salt === "string" && /^[0-9a-f]{32}$/.test(b.salt) && HEX64.test(b.auth || "") && typeof b.wrapped_key === "string" && b.wrapped_key.length < 400;
}

async function v2(req, env, p, url) {
  const M = req.method;
  // 登录前：取这个邮箱的盐和派生参数（没注册的邮箱给一个固定的假盐，免得被拿来试哪些邮箱注册过）
  if (p[0] === "prelogin" && M === "GET") {
    const email = (url.searchParams.get("email") || "").trim().toLowerCase();
    const row = await env.DB.prepare("SELECT salt, kdf FROM users WHERE email = ?").bind(email).first();
    if (row && row.salt) return json({ salt: row.salt, kdf: JSON.parse(row.kdf) });
    return json({ salt: (await sha256("beayy-fake-salt:" + env.INVITE + ":" + email)).slice(0, 32), kdf: KDF });
  }
  if (p[0] === "signup" && M === "GET") { const open = env.OPEN_SIGNUP === "1" || env.OPEN_SIGNUP === "true"; return json({ open, invite: !!env.INVITE && !open, quota: 0, trial_days: 0 }); }
  if (p[0] === "register" && M === "POST") {
    const b = await body(req);
    const open = env.OPEN_SIGNUP === "1" || env.OPEN_SIGNUP === "true";
    if (!open && (!env.INVITE || !(await same(String(b.invite || ""), env.INVITE)))) return json({ error: "邀请码不对" }, 403);
    const email = String(b.email || "").trim().toLowerCase();
    if (!EMAIL.test(email) || !credsOk(b) || !HEX64.test(b.recovery || "")) return json({ error: "注册信息不全" }, 400);
    if (await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first()) return json({ error: "这个邮箱已经注册过了" }, 409);
    const user = hex(rand(12));
    await env.DB.prepare("INSERT INTO users (user, token_hash, created, email, salt, kdf, auth_hash, wrapped_key, recovery_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(user, await sha256(hex(rand(32))), Date.now(), email, b.salt, JSON.stringify(KDF), await sha256(b.auth), b.wrapped_key, await sha256(b.recovery)).run();
    return json({ user, ...(await newSession(env, user, b.name, b.device)) });
  }
  if (p[0] === "login" && M === "POST") {
    const b = await body(req);
    const email = String(b.email || "").trim().toLowerCase();
    const row = await env.DB.prepare("SELECT user, auth_hash, wrapped_key, fails, locked_until FROM users WHERE email = ?").bind(email).first();
    if (row && row.locked_until > Date.now()) return json({ error: "密码错太多次，15 分钟后再试" }, 429);
    if (!row || !row.auth_hash || !HEX64.test(b.auth || "") || !(await same(await sha256(b.auth), row.auth_hash))) {
      if (row) {
        const fails = row.fails + 1;
        await env.DB.prepare("UPDATE users SET fails = ?, locked_until = ? WHERE user = ?").bind(fails % 10, fails >= 10 ? Date.now() + 15 * 60e3 : 0, row.user).run();
      }
      return json({ error: "邮箱或主密码不对" }, 401);
    }
    await env.DB.prepare("UPDATE users SET fails = 0, locked_until = 0 WHERE user = ?").bind(row.user).run();
    return json({ user: row.user, wrapped_key: row.wrapped_key, ...(await newSession(env, row.user, b.name, b.device)) });
  }
  // 忘了主密码：用恢复码重设（设备上用恢复码拿回数据密钥，重新包一层）；之前登录的设备全部登出
  if (p[0] === "recover" && M === "POST") {
    const b = await body(req);
    const email = String(b.email || "").trim().toLowerCase();
    const row = await env.DB.prepare("SELECT user, recovery_hash FROM users WHERE email = ?").bind(email).first();
    if (!row || !row.recovery_hash || !HEX64.test(b.recovery || "") || !(await same(await sha256(b.recovery), row.recovery_hash)) || !credsOk(b))
      return json({ error: "邮箱或恢复码不对" }, 401);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET salt = ?, auth_hash = ?, wrapped_key = ?, fails = 0, locked_until = 0 WHERE user = ?").bind(b.salt, await sha256(b.auth), b.wrapped_key, row.user),
      env.DB.prepare("DELETE FROM sessions WHERE user = ?").bind(row.user),
    ]);
    return json({ ok: true });
  }

  const who = await auth(req, env);
  if (!who) return json({ error: "没登录或令牌不对" }, 401);
  const user = who.user;
  // v1 账号设邮箱和主密码（迁移）：用旧的共用令牌登录着，把同一把数据密钥包一层存上来
  if (p[0] === "claim" && M === "POST") {
    const b = await body(req);
    const email = String(b.email || "").trim().toLowerCase();
    if (!EMAIL.test(email) || !credsOk(b) || !HEX64.test(b.recovery || "")) return json({ error: "信息不全" }, 400);
    const me = await env.DB.prepare("SELECT email FROM users WHERE user = ?").bind(user).first();
    if (me && me.email) return json({ error: "这个账号已经有邮箱了" }, 409);
    if (await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first()) return json({ error: "这个邮箱已经注册过了" }, 409);
    await env.DB.prepare("UPDATE users SET email = ?, salt = ?, kdf = ?, auth_hash = ?, wrapped_key = ?, recovery_hash = ? WHERE user = ?")
      .bind(email, b.salt, JSON.stringify(KDF), await sha256(b.auth), b.wrapped_key, await sha256(b.recovery), user).run();
    return json({ user, ...(await newSession(env, user, b.name, b.device)) });
  }
  if (p[0] === "password" && M === "POST") {
    const b = await body(req);
    if (!credsOk(b)) return json({ error: "信息不全" }, 400);
    await env.DB.prepare("UPDATE users SET salt = ?, auth_hash = ?, wrapped_key = ? WHERE user = ?").bind(b.salt, await sha256(b.auth), b.wrapped_key, user).run();
    return json({ ok: true });
  }
  if (p[0] === "account" && M === "GET") {
    const me = await env.DB.prepare("SELECT email, display_name, avatar, profile_updated FROM users WHERE user = ?").bind(user).first();
    const { results } = await env.DB.prepare("SELECT id, name, device, created, last_seen FROM sessions WHERE user = ? ORDER BY created").bind(user).all();
    const storage = await env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS used FROM blobs WHERE user = ?").bind(user).first();
    return json({ user, email: me ? me.email : null, session: who.session, sessions: results, storage: { used: storage ? storage.used : 0, quota: 0 },
      profile: me ? { name: me.display_name, avatar: me.avatar, updated: me.profile_updated } : null,
      services: { plan: null },
    });
  }
  // 显示名称和头像
  if (p[0] === "profile" && M === "POST") {
    const b = await body(req);
    const name = String(b.name || "").trim().slice(0, 40);
    const avatar = b.avatar == null ? null : String(b.avatar);
    if (avatar && (!avatar.startsWith("data:image/") || avatar.length > 300000)) return json({ error: "头像要是图片，且不超过 300KB" }, 400);
    const now = Date.now();
    await env.DB.prepare("UPDATE users SET display_name = ?, avatar = ?, profile_updated = ? WHERE user = ?").bind(name || null, avatar, now, user).run();
    return json({ updated: now });
  }
  // 移除一台设备的登录（自己退出登录也走这个，id 写 self）
  if (p[0] === "sessions" && p[1] && M === "DELETE") {
    const id = p[1] === "self" ? who.session : p[1];
    if (!id) return json({ error: "这个令牌不是设备登录的" }, 400);
    await env.DB.prepare("DELETE FROM sessions WHERE user = ? AND id = ?").bind(user, id).run();
    return json({ ok: true });
  }
  return json({ error: "没有这个接口" }, 404);
}

function rand(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(s) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}

/** 定时比较两个字符串（先各自哈希，长度一样再逐字节比） */
async function same(a, b) {
  const [x, y] = [await sha256(a), await sha256(b)];
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
