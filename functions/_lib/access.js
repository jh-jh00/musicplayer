import { requireUser } from "./session.js";

// Temporary public mode. Keep account/admin and access-code data intact so the
// original gate can be restored by changing this flag back to false.
export const PUBLIC_APP_ACCESS = true;

export function isAdmin(user, env) {
  const emails = (env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return emails.includes((user?.email || "").toLowerCase());
}

export async function requireAdmin(request, env) {
  const user = await requireUser(request, env);
  if (!user) return { error: Response.json({ error: "unauthorized" }, { status: 401 }) };
  if (!isAdmin(user, env)) return { error: Response.json({ error: "forbidden" }, { status: 403 }) };
  return { user };
}

export function isUnlimitedDuration(durationMs) {
  return durationMs === 0;
}

export function isUnlimitedAccess(row) {
  return isUnlimitedDuration(row?.duration_ms) || row?.expires_at == null;
}

export async function getUserAccess(db, userId) {
  const now = Date.now();
  const row = await db
    .prepare(
      `SELECT id, code, expires_at, redeemed_at, duration_ms
       FROM access_codes
       WHERE redeemed_by = ? AND redeemed_at IS NOT NULL
         AND (duration_ms = 0 OR expires_at IS NULL OR expires_at > ?)
       ORDER BY redeemed_at DESC
       LIMIT 1`
    )
    .bind(userId, now)
    .first();
  if (!row) return null;
  const unlimited = isUnlimitedAccess(row);
  const active = unlimited || row.expires_at > now;
  return {
    id: row.id,
    code: row.code,
    expiresAt: row.expires_at,
    redeemedAt: row.redeemed_at,
    durationMs: row.duration_ms,
    unlimited,
    remainingMs: unlimited ? null : Math.max(0, row.expires_at - now),
    active,
  };
}

export async function requireAccess(request, env) {
  const user = await requireUser(request, env);
  if (user && isAdmin(user, env)) return { user, access: { active: true, admin: true } };
  if (PUBLIC_APP_ACCESS) {
    return { user, access: { active: true, publicAccess: true } };
  }
  if (!user) return { error: Response.json({ error: "unauthorized" }, { status: 401 }) };
  const access = await getUserAccess(env.youtube_player_db, user.sub);
  if (!access?.active) {
    return { error: Response.json({ error: "no_access" }, { status: 403 }) };
  }
  return { user, access };
}

export function normalizeCode(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function randomCode(length = 12) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

export function formatRemaining(ms, unlimited = false) {
  if (unlimited || ms == null) return "무한";
  if (ms <= 0) return "만료됨";
  const totalMin = Math.ceil(ms / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}일 ${hours}시간`;
  if (hours > 0) return `${hours}시간 ${mins}분`;
  return `${mins}분`;
}

export function formatDurationPreset(ms) {
  if (isUnlimitedDuration(ms)) return "무한";
  return formatRemaining(ms);
}
