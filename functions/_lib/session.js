const COOKIE = "ytp_session";
const MAX_AGE = 60 * 60 * 24 * 30;

function b64url(bytes) {
  const bin = String.fromCharCode(...bytes);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signSession(user, secret) {
  const payload = {
    sub: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    createdAt: user.createdAt,
    exp: Date.now() + MAX_AGE * 1000,
  };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

export async function verifySession(token, secret) {
  if (!token || !secret) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const key = await hmacKey(secret);
  try {
    const ok = await crypto.subtle.verify("HMAC", key, b64urlDecode(sig), new TextEncoder().encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (!payload.sub || !Number.isSafeInteger(payload.exp) || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function sessionCookie(token, secure) {
  const flags = [`Path=/`, `Max-Age=${MAX_AGE}`, `HttpOnly`, `SameSite=Lax`];
  if (secure) flags.push("Secure");
  return `${COOKIE}=${token}; ${flags.join("; ")}`;
}

export function clearSessionCookie(secure) {
  const flags = [`Path=/`, `Max-Age=0`, `HttpOnly`, `SameSite=Lax`];
  if (secure) flags.push("Secure");
  return `${COOKIE}=; ${flags.join("; ")}`;
}

export function readSessionCookie(request) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return null;
}

export async function requireUser(request, env) {
  const token = readSessionCookie(request);
  const session = await verifySession(token, env.SESSION_SECRET);
  if (!session) return null;
  const row = await env.youtube_player_db.prepare("SELECT created_at FROM users WHERE id = ?").bind(session.sub).first();
  if (!row) return null;
  if (session.createdAt != null) {
    if (session.createdAt !== row.created_at) return null;
  } else if (row.created_at > session.exp - MAX_AGE * 1000) {
    return null;
  }
  return session;
}
