import player from "./compiled/index.js";

const mount = "";
const loginPath = "/api/auth/login";
const callbackPath = "/api/auth/callback";
const authCookie = "__Secure-ytp_player_oauth";
const sessionCookie = "ytp_session";
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const statePattern = /^playlist-[A-Za-z0-9_-]{43}$/;
const documentPath = /^\/(?:index|watch|admin|terms|privacy)(?:\.html)?$/;
const safeHeaders = ["accept", "content-type", "if-modified-since", "if-none-match", "if-range", "range"];

function asBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function cookies(request) {
  return new Map((request.headers.get("cookie") || "").split(";").map(item => {
    const [key, ...value] = item.trim().split("=");
    return [key, value.join("=")];
  }));
}

function stateCookie(value, age) {
  return `${authCookie}=${value}; Path=${mount}${callbackPath}; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`;
}

function redirect(location, status = 302, cookie) {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(null, { status, headers });
}

function toPlayer(url, path) {
  return new URL(mount + path, url.origin).href;
}

async function dispatch(request, url, path, jar, env, ctx, verifier) {
  const target = new URL(url);
  target.pathname = path;
  target.search = url.search;
  const headers = new Headers();
  for (const header of safeHeaders) {
    const value = request.headers.get(header);
    if (value) headers.set(header, value);
  }
  if (path.startsWith("/api/") && jar.has(sessionCookie)) {
    headers.set("Cookie", sessionCookie + "=" + jar.get(sessionCookie));
  }
  if (verifier) {
    target.search = new URLSearchParams({ code: url.searchParams.get("code") });
    headers.set("X-Player-PKCE", verifier);
  }
  const outbound = new Request(target, new Request(request, { headers, redirect: "manual" }));
  return player.fetch(outbound, { ...env, PLAYER_MOUNT: mount }, ctx);
}

async function startLogin(request, url, jar, env, ctx) {
  const response = await dispatch(request, url, loginPath, jar, env, ctx);
  const location = response.headers.get("Location");
  if (response.status !== 302 || !location) return response;
  const google = new URL(location);
  if (google.origin !== "https://accounts.google.com" ||
      google.searchParams.get("redirect_uri") !== url.origin + mount + callbackPath) {
    return new Response("Login unavailable", { status: 502 });
  }
  const state = "playlist-" + asBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const verifier = asBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  google.searchParams.set("state", state);
  google.searchParams.set("code_challenge", asBase64Url(challenge));
  google.searchParams.set("code_challenge_method", "S256");
  return redirect(google.href, 302, stateCookie(state + "." + verifier, 600));
}

function mountResponse(response, url, path, clearState) {
  const headers = new Headers(response.headers);
  const values = headers.getSetCookie?.() ?? headers.getAll?.("Set-Cookie") ?? [];
  headers.delete("Set-Cookie");
  for (const cookie of values) {
    if (cookie.startsWith(sessionCookie + "=")) {
      headers.append("Set-Cookie", cookie.replace(/;\s*Path=\/(?=;|$)/i, "; Path=" + mount + "/"));
    }
  }
  if (clearState) headers.append("Set-Cookie", stateCookie("", 0));
  const location = headers.get("Location");
  if (location) {
    const destination = new URL(location, url.origin);
    if (destination.origin === url.origin && !destination.pathname.startsWith(mount + "/")) {
      headers.set("Location", toPlayer(url, destination.pathname + destination.search + destination.hash));
    }
  }
  if (path.startsWith("/api/")) headers.set("Cache-Control", "no-store");
  if (path === "/sw.js") headers.set("Service-Worker-Allowed", mount + "/");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/api/debug-log") {
      return new Response(null, { status: 410, headers: { "Cache-Control": "no-store" } });
    }
    if (path.endsWith("/") && documentPath.test(path.slice(0, -1))) {
      return redirect(toPlayer(url, path.slice(0, -1) + url.search), 308);
    }
    const api = /^\/api(?:\/[A-Za-z0-9_-]+)+$/.test(path);
    const asset = path === "/" || documentPath.test(path) ||
      /^\/(?:js|icons)\/[A-Za-z0-9._-]+$/.test(path) ||
      /^\/(?:sw\.js|manifest\.webmanifest|styles(?:-gameboy)?\.css|watch(?:-app)?\.css)$/.test(path);
    if (!api && !asset) return new Response(null, { status: 404 });
    if ((path === loginPath || path === callbackPath) && request.method !== "GET") return new Response(null, { status: 405 });
    if (request.method !== "GET" && request.method !== "HEAD") {
      if (!api) return new Response(null, { status: 405 });
      if (request.headers.get("Origin") !== url.origin) return new Response(null, { status: 403 });
    }

    const jar = cookies(request);
    try {
      if (path === "/api/youtube-search" || path === "/api/youtube-channels-search") {
        const key = request.headers.get("CF-Connecting-IP") || "unknown";
        const { success } = await env.PLAYER_SEARCH_LIMITER.limit({ key });
        if (!success) {
          // 유튜브가 돌려주는 rateLimitExceeded(하루 한도 소진)와 구분되게 이름을 따로 쓴다.
          return Response.json({ error: "searchTooFrequent" }, { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "60" } });
        }
      }
      if (path === loginPath) return await startLogin(request, url, jar, env, ctx);
      if (path === callbackPath) {
        const state = url.searchParams.get("state") || "";
        const [expected, verifier] = (jar.get(authCookie) || "").split(".");
        const code = url.searchParams.get("code");
        if (!statePattern.test(state) || state !== expected || !tokenPattern.test(verifier || "") || !code) {
          return redirect(toPlayer(url, "/?auth=fail"), 302, stateCookie("", 0));
        }
        return mountResponse(await dispatch(request, url, path, jar, env, ctx, verifier), url, path, true);
      }
      return mountResponse(await dispatch(request, url, path, jar, env, ctx), url, path, false);
    } catch {
      return new Response("Playlist Player is temporarily unavailable.", { status: 502 });
    }
  },
};
