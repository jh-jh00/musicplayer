const MAX_MESSAGE_LEN = 4000;
const MAX_LOGS = 160;

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

function cleanText(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function trimLogs(logs) {
  if (!Array.isArray(logs)) return [];
  return logs.slice(-MAX_LOGS);
}

export async function onRequestPost({ request, env }) {
  const db = env.youtube_player_db;
  if (!db) return Response.json({ ok: false, error: "no_db" }, { status: 503 });

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  const type = cleanText(body.type, "feedback").slice(0, 40) || "feedback";
  const message = cleanText(body.message).slice(0, MAX_MESSAGE_LEN);
  if (!message) return Response.json({ ok: false, error: "message_required" }, { status: 400 });

  const payload = {
    ...body,
    type,
    message,
    logs: trimLogs(body.logs),
  };

  await ensureTable(db);
  await db
    .prepare("INSERT INTO feedback_reports (type, message, payload, created_at) VALUES (?, ?, ?, ?)")
    .bind(type, message, JSON.stringify(payload), Date.now())
    .run();

  return Response.json({ ok: true });
}
