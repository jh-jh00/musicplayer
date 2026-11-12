import {
  requireAdmin,
  randomCode,
  formatRemaining,
  formatDurationPreset,
} from "../../_lib/access.js";

async function listCodes(db) {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.code, c.duration_ms, c.created_at, c.created_by,
              c.redeemed_by, c.redeemed_at, c.expires_at,
              u.email AS user_email, u.name AS user_name
       FROM access_codes c
       LEFT JOIN users u ON u.id = c.redeemed_by
       ORDER BY c.created_at DESC`
    )
    .all();

  const now = Date.now();
  return (results || []).map((r) => {
    const unlimited = r.duration_ms === 0;
    let status = "unused";
    if (r.redeemed_by) {
      status = unlimited || (r.expires_at != null && r.expires_at > now) ? "active" : "expired";
    }
    const remainingMs =
      r.redeemed_by && !unlimited && r.expires_at != null ? Math.max(0, r.expires_at - now) : null;
    const durationLabel = formatDurationPreset(r.duration_ms);
    return {
      id: r.id,
      code: r.code,
      status,
      unlimited: r.duration_ms === 0,
      durationMs: r.duration_ms,
      durationLabel,
      createdAt: r.created_at,
      redeemedAt: r.redeemed_at,
      expiresAt: r.expires_at,
      remainingMs,
      remainingLabel: !r.redeemed_by
        ? "—"
        : unlimited
          ? "무한"
          : remainingMs != null
            ? formatRemaining(remainingMs)
            : "—",
      user: r.redeemed_by
        ? { id: r.redeemed_by, email: r.user_email, name: r.user_name }
        : null,
    };
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;
  const codes = await listCodes(env.youtube_player_db);
  return Response.json({ codes });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const unlimited = Boolean(body.unlimited);
  let durationMs = 0;
  let durationDays = null;
  if (!unlimited) {
    durationDays = Number(body.durationDays ?? body.days ?? 30);
    if (!Number.isFinite(durationDays) || durationDays < 1 / 24 || durationDays > 3650) {
      return Response.json({ error: "invalid_duration" }, { status: 400 });
    }
    durationMs = Math.round(durationDays * 24 * 60 * 60 * 1000);
  }
  const id = crypto.randomUUID();
  let code = randomCode(12);
  const now = Date.now();

  for (let i = 0; i < 5; i++) {
    try {
      await env.youtube_player_db
        .prepare(
          `INSERT INTO access_codes (id, code, duration_ms, created_at, created_by)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(id, code, durationMs, now, auth.user.sub)
        .run();
      return Response.json({ ok: true, id, code, durationMs, unlimited, durationDays });
    } catch {
      code = randomCode(12);
    }
  }

  return Response.json({ error: "create_failed" }, { status: 500 });
}
