import { requireUser } from "../../_lib/session.js";
import { clearSessionCookie } from "../../_lib/session.js";
import {
  WITHDRAW_CONFIRMATION,
  deleteUserAccount,
  revokeGoogleToken,
} from "../../_lib/account.js";

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

  if (body.confirmation !== WITHDRAW_CONFIRMATION) {
    return Response.json({ error: "invalid_confirmation" }, { status: 400 });
  }

  try {
    const refreshToken = await deleteUserAccount(env.youtube_player_db, user.sub);
    const googleRevoked = await revokeGoogleToken(refreshToken);

    const secure = new URL(request.url).protocol === "https:";
    return new Response(JSON.stringify({ ok: true, googleRevoked }), {
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": clearSessionCookie(secure),
      },
    });
  } catch {
    return Response.json({ error: "withdraw_failed" }, { status: 500 });
  }
}
