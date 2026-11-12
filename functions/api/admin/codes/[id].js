import { requireAdmin } from "../../../_lib/access.js";

export async function onRequestPatch(context) {
  const { request, env, params } = context;
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  const id = params.id;
  if (!id) return Response.json({ error: "id_required" }, { status: 400 });

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const row = await env.youtube_player_db
    .prepare(`SELECT id, expires_at, redeemed_by, duration_ms FROM access_codes WHERE id = ?`)
    .bind(id)
    .first();

  if (!row) return Response.json({ error: "not_found" }, { status: 404 });
  if (!row.redeemed_by) {
    return Response.json({ error: "not_redeemed" }, { status: 400 });
  }

  if (body.unlimited === true) {
    await env.youtube_player_db
      .prepare(`UPDATE access_codes SET expires_at = NULL, duration_ms = 0 WHERE id = ?`)
      .bind(id)
      .run();
    return Response.json({ ok: true, unlimited: true, expiresAt: null, remainingMs: null });
  }

  const base = row.expires_at ?? Date.now();
  let expiresAt = base;
  if (body.expiresAt != null) {
    expiresAt = Number(body.expiresAt);
  } else if (body.expiresAtIso) {
    expiresAt = new Date(body.expiresAtIso).getTime();
  } else {
    let adjustMs = 0;
    if (body.adjustMs != null) {
      adjustMs = Number(body.adjustMs);
    } else if (body.adjustMinutes != null) {
      adjustMs = Number(body.adjustMinutes) * 60 * 1000;
    } else if (body.adjustHours != null) {
      adjustMs = Number(body.adjustHours) * 60 * 60 * 1000;
    } else if (body.adjustDays != null) {
      adjustMs = Number(body.adjustDays) * 24 * 60 * 60 * 1000;
    }
    if (!Number.isFinite(adjustMs) || adjustMs === 0) {
      return Response.json({ error: "invalid_adjust" }, { status: 400 });
    }
    expiresAt = base + adjustMs;
  }

  if (!Number.isFinite(expiresAt) || expiresAt < Date.now() - 86400000) {
    return Response.json({ error: "invalid_expires" }, { status: 400 });
  }

  await env.youtube_player_db
    .prepare(`UPDATE access_codes SET expires_at = ?, duration_ms = ? WHERE id = ?`)
    .bind(Math.round(expiresAt), Math.max(1, Math.round(expiresAt - (row.redeemed_at || Date.now()))), id)
    .run();

  const remainingMs = Math.max(0, expiresAt - Date.now());
  return Response.json({ ok: true, unlimited: false, expiresAt, remainingMs });
}

export async function onRequestDelete(context) {
  const { request, env, params } = context;
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  const id = params.id;
  if (!id) return Response.json({ error: "id_required" }, { status: 400 });

  const row = await env.youtube_player_db
    .prepare(`SELECT id FROM access_codes WHERE id = ?`)
    .bind(id)
    .first();

  if (!row) return Response.json({ error: "not_found" }, { status: 404 });

  await env.youtube_player_db.prepare(`DELETE FROM access_codes WHERE id = ?`).bind(id).run();
  return Response.json({ ok: true });
}
