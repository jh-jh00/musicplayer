
import assert from "node:assert/strict";
import { stdout } from "node:process";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const [root, stage] = process.argv.slice(2).map(dir => pathToFileURL(dir + "/"));
const { default: worker } = await import(new URL("worker.mjs", stage));
const { signSession } = await import(new URL("functions/_lib/session.js", root));
const db = new DatabaseSync(":memory:");
db.exec(await readFile(new URL("schema.sql", root), "utf8"));
const user = { id: "audit-user", email: "audit@example.test", name: "audit", createdAt: 1 };
const secret = crypto.randomUUID() + crypto.randomUUID();
const cookie = "ytp_session=" + await signSession(user, secret);
const existing = { playlists: [{ id: "kept", items: [] }] };
db.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)").run(user.id, 1);
db.prepare("INSERT INTO player_state VALUES (?, ?, ?)").run(user.id, JSON.stringify(existing), 1);
db.prepare("INSERT INTO access_codes (id,code,duration_ms,created_at,redeemed_by) VALUES (?,?,?,?,?)")
  .run("code", "SYNTHETIC", 0, 1, user.id);
let failDelete = false;
const env = {
  SESSION_SECRET: secret,
  PLAYER_SEARCH_LIMITER: { async limit({ key }) {
    assert.equal(key, "192.0.2.2");
    return { success: false };
  } },
  youtube_player_db: {
    prepare(sql) {
      return { bind(...args) {
        return {
          async first() { return db.prepare(sql).get(...args); },
          execute() {
            if (failDelete && sql.startsWith("DELETE FROM users")) throw Error("simulated DB failure");
            const statement = db.prepare(sql);
            const results = sql.includes("RETURNING") ? statement.all(...args) : (statement.run(...args), []);
            return { results };
          },
        };
      } };
    },
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const result = statements.map(statement => statement.execute());
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  },
};
const ctx = { waitUntil() {}, passThroughOnException() {} };
const origin = "https://player-example.workers.dev";
const call = (path, method = "GET", data, signed = true) => worker.fetch(new Request(origin + "/" + path, {
  method,
  body: data === undefined ? undefined : JSON.stringify(data),
  headers: { Cookie: signed ? cookie : "", Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.2" },
}), env, ctx);
assert.equal((await call("api/debug-log", "GET", undefined, false)).status, 410);
assert.equal((await call("api/debug-log", "POST", {}, false)).status, 410);
assert.equal((await call("api/youtube-search?q=test")).status, 429);
assert.equal((await call("api/youtube-channels-search?q=test")).status, 429);

const newer = { playlists: [{ id: "changed", items: [] }], syncUid: user.id };
assert.equal((await call("api/player-state", "POST", newer)).status, 409);
assert.equal((await call("api/player-state", "POST", { ...newer, expectedUpdatedAt: null })).status, 409);
assert.equal((await call("api/player-state", "POST", { ...newer, syncUid: "other", expectedUpdatedAt: 1 })).status, 409);
assert.equal((await call("api/player-state", "POST", { ...newer, expectedUpdatedAt: 1 })).status, 200);
assert.equal((await call("api/player-state", "POST", { ...newer, expectedUpdatedAt: 1 })).status, 409);

globalThis.localStorage = { getItem() { return null; }, setItem() {} };
let attemptedWrites = 0;
globalThis.fetch = async (path, options = {}) => {
  if (path === "api/config") return Response.json({ authConfigured: true });
  if (path === "api/player-state") {
    if (options.method === "POST") attemptedWrites += 1;
    return new Response(null, { status: 502 });
  }
  return call(path);
};
const { initAuth } = await import(new URL("js/auth.js", root));
const { syncOnLogin, hookAutoSync } = await import(new URL("js/sync.js", root));
const { createPlaylist } = await import(new URL("js/playlists.js", root));
await initAuth();
hookAutoSync();
assert.equal(await syncOnLogin(), "sync_paused");
createPlaylist("Local");
await new Promise(resolve => setTimeout(resolve, 950));
assert.equal(attemptedWrites, 0);
assert.equal((await (await call("api/player-state")).json()).playlists[0].id, "changed");

const confirmation = { confirmation: "위 내용을 모두 이해했습니다" };
failDelete = true;
assert.equal((await call("api/auth/withdraw", "POST", confirmation)).status, 500);
assert.equal(db.prepare("SELECT user_id FROM player_state").get().user_id, user.id);
assert.equal(db.prepare("SELECT redeemed_by FROM access_codes").get().redeemed_by, user.id);
failDelete = false;
assert.equal((await call("api/auth/withdraw", "POST", confirmation)).status, 200);
assert.equal((await call("api/auth/me")).status, 401);
db.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)").run(user.id, Date.now());
assert.equal((await call("api/auth/me")).status, 401);
stdout.write("PASS disabled log endpoint, search rate limit, sync read failure and write conflicts, atomic withdrawal, stale session revocation\n");
const initialConfig = await (await call("api/config", "GET", undefined, false)).json();
assert.equal(initialConfig.searchConfigured, false);
assert.equal(initialConfig.authConfigured, false);
assert.equal((await call("api/auth/login", "GET", undefined, false)).status, 503);
env.ASSETS = {
  async fetch(request) {
    assert.equal(new URL(request.url).pathname, "/");
    return new Response("<!doctype html><title>Playlist Player</title>");
  },
};
const watch = await call("watch?v=jNQXAC9IVRw", "GET", undefined, false);
assert.equal(watch.status, 200);
assert.match(await watch.text(), /Playlist Player/);
assert.equal((await call("watch/?v=jNQXAC9IVRw")).headers.get("Location"), origin + "/watch?v=jNQXAC9IVRw");

env.GOOGLE_CLIENT_ID = "example-client-id";
env.GOOGLE_CLIENT_SECRET = "test-only-oauth-value";
const oauth = await call("api/auth/login", "GET", undefined, false);
assert.equal(oauth.status, 302);
const oauthLocation = new URL(oauth.headers.get("Location"));
assert.equal(oauthLocation.searchParams.get("redirect_uri"), origin + "/api/auth/callback");
assert.equal(oauthLocation.searchParams.get("code_challenge_method"), "S256");
const oauthCookie = oauth.headers.get("Set-Cookie").split(";")[0];
assert.match(oauth.headers.get("Set-Cookie"), /Path=\/api\/auth\/callback;.*HttpOnly; Secure; SameSite=Lax/);
const callback = (state) => worker.fetch(new Request(origin + "/api/auth/callback?" + new URLSearchParams({
  code: "sample-auth-code", state,
}), { headers: { Cookie: oauthCookie } }), env, ctx);
assert.equal((await callback("invalid-state")).headers.get("Location"), origin + "/?auth=fail");
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (url, options) => {
    if (url === "https://oauth2.googleapis.com/token") {
      const verifier = options.body.get("code_verifier");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
      assert.equal(Buffer.from(digest).toString("base64url"), oauthLocation.searchParams.get("code_challenge"));
      return Response.json({ access_token: "sample-access-token", refresh_token: "not-saved" });
    }
    assert.equal(url, "https://www.googleapis.com/oauth2/v3/userinfo");
    return Response.json({ sub: "oauth-test", email: "oauth@example.test" });
  };
  const signedIn = await callback(oauthLocation.searchParams.get("state"));
  assert.equal(signedIn.headers.get("Location"), origin + "/?auth=ok");
  assert.ok(signedIn.headers.getSetCookie().some(value => /^ytp_session=.*;\s*Path=\//.test(value)));
  assert.equal(db.prepare("SELECT google_refresh_token FROM users WHERE id = ?").get("oauth-test").google_refresh_token, null);
} finally {
  globalThis.fetch = originalFetch;
}

const { resolveUrlsToItems } = await import(new URL("js/playlists.js", root));
try {
  globalThis.fetch = async () => { throw new Error("Metadata unavailable"); };
  const resolved = await resolveUrlsToItems(["https://www.youtube.com/watch?v=jNQXAC9IVRw"]);
  assert.equal(resolved.items[0].vid, "jNQXAC9IVRw");
} finally {
  globalThis.fetch = originalFetch;
}
stdout.write("PASS standalone watch route, OAuth callback and PKCE, and single-link fallback without an API key\n");
