/**
 * Hamdel Couple App — Cloudflare Worker + D1
 * Pair two phones with a code, sync ratings & feelings in real time.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Device-Id",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

function code6() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const db = env.DB;

    try {
      if (path === "/" || path === "/health") {
        return json({ ok: true, app: "Hamdel", version: "1.0.0" });
      }

      if (path === "/api/pair/create" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const deviceId = body.deviceId || request.headers.get("X-Device-Id") || crypto.randomUUID();
        const myName = (body.name || "عشق من").slice(0, 40);
        const code = code6();
        const id = crypto.randomUUID();
        await db
          .prepare(
            `INSERT INTO couples (id, code, device_a, name_a, created_at) VALUES (?, ?, ?, ?, datetime('now'))`
          )
          .bind(id, code, deviceId, myName)
          .run();
        return json({ ok: true, coupleId: id, code, deviceId, role: "a" });
      }

      if (path === "/api/pair/join" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const deviceId = body.deviceId || request.headers.get("X-Device-Id") || crypto.randomUUID();
        const code = (body.code || "").toUpperCase().trim();
        const myName = (body.name || "عشق من").slice(0, 40);
        if (!code || code.length < 4) return json({ ok: false, error: "کد نامعتبر" }, 400);

        const row = await db.prepare(`SELECT * FROM couples WHERE code = ?`).bind(code).first();
        if (!row) return json({ ok: false, error: "کد پیدا نشد" }, 404);
        if (row.device_b && row.device_b !== deviceId) {
          return json({ ok: false, error: "این اتاق قبلاً پر شده" }, 409);
        }
        if (row.device_a === deviceId) {
          return json({
            ok: true,
            coupleId: row.id,
            code: row.code,
            deviceId,
            role: "a",
            partnerName: row.name_b || null,
            myName: row.name_a,
          });
        }

        await db
          .prepare(
            `UPDATE couples SET device_b = ?, name_b = ?, joined_at = datetime('now') WHERE id = ?`
          )
          .bind(deviceId, myName, row.id)
          .run();

        return json({
          ok: true,
          coupleId: row.id,
          code: row.code,
          deviceId,
          role: "b",
          partnerName: row.name_a,
          myName,
        });
      }

      if (path === "/api/pair/status" && request.method === "GET") {
        const coupleId = url.searchParams.get("coupleId");
        const deviceId = url.searchParams.get("deviceId") || request.headers.get("X-Device-Id");
        if (!coupleId || !deviceId) return json({ ok: false, error: "missing params" }, 400);
        const row = await db.prepare(`SELECT * FROM couples WHERE id = ?`).bind(coupleId).first();
        if (!row) return json({ ok: false, error: "not found" }, 404);
        const isA = row.device_a === deviceId;
        const isB = row.device_b === deviceId;
        if (!isA && !isB) return json({ ok: false, error: "unauthorized" }, 403);
        return json({
          ok: true,
          paired: !!(row.device_a && row.device_b),
          myName: isA ? row.name_a : row.name_b,
          partnerName: isA ? row.name_b : row.name_a,
          role: isA ? "a" : "b",
          code: row.code,
        });
      }

      if (path === "/api/feelings" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const deviceId = body.deviceId || request.headers.get("X-Device-Id");
        const { coupleId, type, stars, comment, moods } = body;
        if (!coupleId || !deviceId || !type) return json({ ok: false, error: "missing fields" }, 400);

        const couple = await db.prepare(`SELECT * FROM couples WHERE id = ?`).bind(coupleId).first();
        if (!couple) return json({ ok: false, error: "couple not found" }, 404);
        const isA = couple.device_a === deviceId;
        const isB = couple.device_b === deviceId;
        if (!isA && !isB) return json({ ok: false, error: "unauthorized" }, 403);
        if (!couple.device_b) return json({ ok: false, error: "partner not joined yet" }, 400);

        const fromRole = isA ? "a" : "b";
        const toRole = isA ? "b" : "a";
        const fromName = isA ? couple.name_a : couple.name_b;
        const id = crypto.randomUUID();
        const moodsJson = JSON.stringify(moods || []);

        await db
          .prepare(
            `INSERT INTO feelings (id, couple_id, from_role, to_role, type, stars, comment, moods, from_name, created_at, is_read)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 0)`
          )
          .bind(
            id,
            coupleId,
            fromRole,
            toRole,
            type,
            stars != null ? Math.min(5, Math.max(1, Number(stars))) : null,
            (comment || "").slice(0, 500),
            moodsJson,
            fromName
          )
          .run();

        return json({ ok: true, id, message: "ارسال شد 💕" });
      }

      if (path === "/api/feelings" && request.method === "GET") {
        const coupleId = url.searchParams.get("coupleId");
        const deviceId = url.searchParams.get("deviceId") || request.headers.get("X-Device-Id");
        const since = url.searchParams.get("since") || "0";
        if (!coupleId || !deviceId) return json({ ok: false, error: "missing params" }, 400);

        const couple = await db.prepare(`SELECT * FROM couples WHERE id = ?`).bind(coupleId).first();
        if (!couple) return json({ ok: false, error: "not found" }, 404);
        const isA = couple.device_a === deviceId;
        const isB = couple.device_b === deviceId;
        if (!isA && !isB) return json({ ok: false, error: "unauthorized" }, 403);
        const myRole = isA ? "a" : "b";

        const rows = await db
          .prepare(
            `SELECT * FROM feelings WHERE couple_id = ? AND to_role = ? AND created_at > datetime(?, 'unixepoch')
             ORDER BY created_at DESC LIMIT 50`
          )
          .bind(coupleId, myRole, Number(since) || 0)
          .all();

        await db
          .prepare(`UPDATE feelings SET is_read = 1 WHERE couple_id = ? AND to_role = ? AND is_read = 0`)
          .bind(coupleId, myRole)
          .run();

        const items = (rows.results || []).map((r) => ({
          id: r.id,
          type: r.type,
          stars: r.stars,
          comment: r.comment,
          moods: JSON.parse(r.moods || "[]"),
          fromName: r.from_name,
          createdAt: r.created_at,
          isRead: !!r.is_read,
        }));

        return json({ ok: true, items, partnerName: isA ? couple.name_b : couple.name_a });
      }

      if (path === "/api/unread" && request.method === "GET") {
        const coupleId = url.searchParams.get("coupleId");
        const deviceId = url.searchParams.get("deviceId") || request.headers.get("X-Device-Id");
        if (!coupleId || !deviceId) return json({ ok: false, error: "missing" }, 400);
        const couple = await db.prepare(`SELECT * FROM couples WHERE id = ?`).bind(coupleId).first();
        if (!couple) return json({ ok: false, error: "not found" }, 404);
        const isA = couple.device_a === deviceId;
        const isB = couple.device_b === deviceId;
        if (!isA && !isB) return json({ ok: false, error: "unauthorized" }, 403);
        const myRole = isA ? "a" : "b";
        const row = await db
          .prepare(
            `SELECT COUNT(*) as c FROM feelings WHERE couple_id = ? AND to_role = ? AND is_read = 0`
          )
          .bind(coupleId, myRole)
          .first();
        return json({ ok: true, unread: row?.c || 0 });
      }

      if (path === "/api/setup" && request.method === "POST") {
        await db.batch([
          db.prepare(`
            CREATE TABLE IF NOT EXISTS couples (
              id TEXT PRIMARY KEY,
              code TEXT UNIQUE NOT NULL,
              device_a TEXT NOT NULL,
              device_b TEXT,
              name_a TEXT,
              name_b TEXT,
              created_at TEXT,
              joined_at TEXT
            )
          `),
          db.prepare(`CREATE INDEX IF NOT EXISTS idx_couples_code ON couples(code)`),
          db.prepare(`
            CREATE TABLE IF NOT EXISTS feelings (
              id TEXT PRIMARY KEY,
              couple_id TEXT NOT NULL,
              from_role TEXT NOT NULL,
              to_role TEXT NOT NULL,
              type TEXT NOT NULL,
              stars INTEGER,
              comment TEXT,
              moods TEXT,
              from_name TEXT,
              created_at TEXT,
              is_read INTEGER DEFAULT 0
            )
          `),
          db.prepare(`CREATE INDEX IF NOT EXISTS idx_feelings_couple ON feelings(couple_id, to_role, created_at)`),
        ]);
        return json({ ok: true, message: "schema ready" });
      }

      return json({ ok: false, error: "not found" }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 500);
    }
  },
};
