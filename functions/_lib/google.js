export function originFrom(request) {
  const url = new URL(request.url);
  return url.origin;
}

export function redirectUri(request, env) {
  return `${originFrom(request)}${env.PLAYER_MOUNT || ""}/api/auth/callback`;
}

export function loginRedirect(request, env) {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(request, env),
    response_type: "code",
    // 구독은 우리 사이트 안에서 직접 다룬다 — 유튜브 계정 권한을 요청하지 않는다.
    scope: "openid email profile",
    prompt: "select_account",
  });
  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, 302);
}

export async function exchangeCode(request, env, code, verifier = "") {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(request, env),
      grant_type: "authorization_code",
      ...(verifier ? { code_verifier: verifier } : {}),
    }),
  });
  if (!res.ok) throw new Error("token_exchange_failed");
  return res.json();
}

export async function fetchGoogleUser(accessToken) {
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error("userinfo_failed");
  return res.json();
}
