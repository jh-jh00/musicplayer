import { requireUser } from "../../_lib/session.js";
import { getUserAccess, normalizeCode } from "../../_lib/access.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const user = await requireUser(request, env);
  if (!user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const code = normalizeCode(body.code);
  if (!code || code.length < 6) {
    return Response.json({ error: "invalid_code" }, { status: 400 });
  }

  const existing = await getUserAccess(env.youtube_player_db, user.sub);
  if (existing?.active) {
    return Response.json({ error: "already_active" }, { status: 409 });
  }

  const row = await env.youtube_player_db
    .prepare(`SELECT id, code, duration_ms, redeemed_by FROM access_codes WHERE code = ?`)
    .bind(code)
    .first();

  if (!row) {
    return Response.json({ error: "code_not_found" }, { status: 404 });
  }
  if (row.redeemed_by) {
    return Response.json({ error: "code_used" }, { status: 409 });
  }

  const now = Date.now();
  const unlimited = row.duration_ms === 0;
  const expiresAt = unlimited ? null : now + row.duration_ms;

  await env.youtube_player_db
    .prepare(
      `UPDATE access_codes
       SET redeemed_by = ?, redeemed_at = ?, expires_at = ?
       WHERE id = ? AND redeemed_by IS NULL`
    )
    .bind(user.sub, now, expiresAt, row.id)
    .run();

  return Response.json({
    ok: true,
    unlimited,
    expiresAt,
    remainingMs: unlimited ? null : row.duration_ms,
    code: row.code,
  });
}
