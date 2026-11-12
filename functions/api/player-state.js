import { requireAccess } from "../_lib/access.js";

export async function onRequest({ request, env }) {
  const auth = await requireAccess(request, env);
  if (auth.error) return auth.error;
  const user = auth.user;
  if (!user) {
    return Response.json({ error: "login_required_for_sync" }, { status: 401 });
  }

  const db = env.youtube_player_db;
  if (request.method === "GET") {
    const row = await db.prepare("SELECT data, updated_at FROM player_state WHERE user_id = ?")
      .bind(user.sub)
      .first();
    if (!row) return Response.json(null);
    try {
      const data = JSON.parse(row.data);
      if (!Array.isArray(data?.playlists)) throw new Error("invalid_state");
      return Response.json({ ...data, updatedAt: row.updated_at });
    } catch {
      return Response.json({ error: "state_unreadable" }, { status: 500 });
    }
  }

  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const body = await request.json().catch(() => null);
  if (!Array.isArray(body?.playlists)) {
    return Response.json({ error: "invalid_state" }, { status: 400 });
  }

  const { expectedUpdatedAt, syncUid, ...state } = body;
  if (syncUid !== user.sub ||
      (expectedUpdatedAt !== null && !Number.isSafeInteger(expectedUpdatedAt))) {
    return Response.json({ error: "sync_conflict" }, { status: 409 });
  }

  const now = Date.now();
  const data = JSON.stringify(state);
  const row = expectedUpdatedAt === null
    ? await db.prepare(
        "INSERT INTO player_state (user_id, data, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(user_id) DO NOTHING RETURNING updated_at"
      ).bind(user.sub, data, now).first()
    : await db.prepare(
        "UPDATE player_state SET data = ?, updated_at = MAX(updated_at + 1, ?) " +
        "WHERE user_id = ? AND updated_at = ? RETURNING updated_at"
      ).bind(data, now, user.sub, expectedUpdatedAt).first();

  if (!row) return Response.json({ error: "sync_conflict" }, { status: 409 });
  return Response.json({ ok: true, updatedAt: row.updated_at });
}
