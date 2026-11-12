import { requireAdmin } from "../../_lib/access.js";

async function ensureTable(db) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS feedback_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`
    )
    .run();
}

function safeJson(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  const db = env.youtube_player_db;
  if (!db) return Response.json({ ok: false, error: "no_db" }, { status: 503 });

  await ensureTable(db);
  const { results } = await db
    .prepare(
      `SELECT id, type, message, payload, created_at
       FROM feedback_reports
       ORDER BY created_at DESC
       LIMIT 100`
    )
    .all();

  const reports = (results || []).map((row) => ({
    id: row.id,
    type: row.type,
    message: row.message,
    payload: safeJson(row.payload),
    createdAt: row.created_at,
  }));

  return Response.json({ ok: true, reports });
}
