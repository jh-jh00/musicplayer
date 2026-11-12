export async function onRequest({ request, env }) {
  const indexUrl = new URL("/", request.url);
  const assetResponse = await env.ASSETS.fetch(new Request(indexUrl, request));
  const headers = new Headers(assetResponse.headers);
  headers.set("Cache-Control", "no-cache, must-revalidate");
  if (assetResponse.status === 304) {
    return new Response(null, { status: 304, headers });
  }
  const html = await assetResponse.text();
  return new Response(html, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers,
  });
}
