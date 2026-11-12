import { clearSessionCookie } from "../../_lib/session.js";

export async function onRequest({ request }) {
  const secure = new URL(request.url).protocol === "https:";
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": clearSessionCookie(secure),
    },
  });
}
