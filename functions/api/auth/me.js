import { requireUser } from "../../_lib/session.js";

export async function onRequest(context) {
  const user = await requireUser(context.request, context.env);
  if (!user) {
    return new Response(JSON.stringify(null), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return Response.json({
    uid: user.sub,
    email: user.email,
    displayName: user.name,
    photoURL: user.picture,
  });
}
