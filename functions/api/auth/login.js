import { loginRedirect } from "../../_lib/google.js";

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.SESSION_SECRET) {
    return new Response("Google OAuth가 설정되지 않았습니다.", { status: 503 });
  }
  return loginRedirect(request, env);
}
