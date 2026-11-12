import { requireUser } from "../../_lib/session.js";
import { getUserAccess, isAdmin, PUBLIC_APP_ACCESS } from "../../_lib/access.js";

export async function onRequest(context) {
  const { request, env } = context;
  const user = await requireUser(request, env);
  if (!user) {
    if (PUBLIC_APP_ACCESS) {
      return Response.json({
        loggedIn: false,
        active: true,
        admin: false,
        publicAccess: true,
        expiresAt: null,
        remainingMs: null,
      });
    }
    return Response.json({ loggedIn: false, active: false }, { status: 401 });
  }

  if (isAdmin(user, env)) {
    return Response.json({
      loggedIn: true,
      active: true,
      admin: true,
      expiresAt: null,
      remainingMs: null,
    });
  }

  if (PUBLIC_APP_ACCESS) {
    return Response.json({
      loggedIn: true,
      active: true,
      admin: false,
      publicAccess: true,
      expiresAt: null,
      remainingMs: null,
    });
  }

  const access = await getUserAccess(env.youtube_player_db, user.sub);
  return Response.json({
    loggedIn: true,
    active: Boolean(access?.active),
    admin: false,
    expiresAt: access?.expiresAt ?? null,
    remainingMs: access?.remainingMs ?? 0,
    unlimited: Boolean(access?.unlimited),
    code: access?.code ?? null,
  });
}
