import { getApiKeys } from "../_lib/youtube.js";

export async function onRequest({ env }) {
  return Response.json({
    authConfigured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.SESSION_SECRET),
    searchConfigured: getApiKeys(env).length > 0,
    // 키 값이 아니라 개수만 알려 준다 — 두 번째 키가 잡혔는지 확인용.
    searchKeyCount: getApiKeys(env).length,
  });
}
