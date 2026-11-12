import { exchangeCode, fetchGoogleUser, originFrom } from "../../_lib/google.js";
import { signSession, sessionCookie } from "../../_lib/session.js";

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const secure = url.protocol === "https:";
  const verifier = request.headers.get("X-Player-PKCE") || "";
  if (verifier && !/^[A-Za-z0-9_-]{43}$/.test(verifier)) {
    return new Response("Invalid OAuth verifier", { status: 400 });
  }

  if (!code) {
    return Response.redirect(`${originFrom(request)}/?auth=fail`, 302);
  }

  try {
    const tokens = await exchangeCode(request, env, code, verifier);
    const profile = await fetchGoogleUser(tokens.access_token);
    const user = {
      id: profile.sub,
      email: profile.email || "",
      name: profile.name || "",
      picture: profile.picture || "",
    };

    const account = await env.youtube_player_db.prepare(
      `INSERT INTO users (id, email, name, picture, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         email=excluded.email,
         name=excluded.name,
         picture=excluded.picture
       RETURNING created_at`
    )
      .bind(
        user.id,
        user.email,
        user.name,
        user.picture,
        Date.now()
      )
      .first();

    const token = await signSession({ ...user, createdAt: account.created_at }, env.SESSION_SECRET);
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${originFrom(request)}/?auth=ok`,
        "Set-Cookie": sessionCookie(token, secure),
      },
    });
  } catch {
    return Response.redirect(`${originFrom(request)}/?auth=fail`, 302);
  }
}
