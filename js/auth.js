let currentUser = null;
let authListeners = new Set();
let configured = false;

const api = (path, opts = {}) =>
  fetch(path, { credentials: "include", ...opts });

export async function initAuth() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const cfg = await api("api/config", { signal: controller.signal });
    if (cfg.ok) {
      const { authConfigured } = await cfg.json();
      configured = authConfigured;
    }
    await refreshUser(controller.signal);
    return configured;
  } catch {
    configured = false;
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshUser(signal) {
  try {
    const res = await api("api/auth/me", { signal });
    if (res.ok) {
      const data = await res.json();
      currentUser = data
        ? {
            uid: data.uid,
            email: data.email,
            displayName: data.displayName,
            photoURL: data.photoURL,
          }
        : null;
    } else {
      currentUser = null;
    }
  } catch {
    currentUser = null;
  }
  authListeners.forEach((fn) => fn(currentUser));
}

export function onAuthChange(fn) {
  authListeners.add(fn);
  fn(currentUser);
  return () => authListeners.delete(fn);
}

export function getUser() {
  return currentUser;
}

export function isConfigured() {
  return configured;
}

export async function signInWithGoogle() {
  if (!configured) {
    throw new Error("Google OAuth가 설정되지 않았습니다. Cloudflare Secrets를 확인하세요.");
  }
  window.location.href = "api/auth/login";
}

export async function signOutUser() {
  const response = await api("api/auth/logout", { method: "POST" });
  if (!response.ok) throw new Error("로그아웃 요청에 실패했습니다.");
  currentUser = null;
  authListeners.forEach((fn) => fn(null));
}

export async function withdrawAccount(confirmation) {
  const res = await api("api/auth/withdraw", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmation }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "withdraw_failed");
  }
  currentUser = null;
  authListeners.forEach((fn) => fn(null));
  return data;
}

export async function pullRemoteState() {
  if (!currentUser) return null;
  const res = await api("api/player-state");
  if (!res.ok) throw new Error("sync_read_failed");
  return res.json();
}

export async function pushRemoteState(state, expectedUpdatedAt) {
  if (!currentUser) return false;
  const res = await api("api/player-state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...state, expectedUpdatedAt }),
  });
  if (!res.ok) throw new Error(res.status === 409 ? "sync_conflict" : "sync_write_failed");
  return res.json();
}

export async function handleAuthRedirectQuery() {
  const q = new URLSearchParams(window.location.search);
  if (!q.has("auth")) return null;
  const result = q.get("auth") === "ok" ? "ok" : "fail";
  q.delete("auth");
  const next = `${window.location.pathname}${q.toString() ? `?${q}` : ""}`;
  window.history.replaceState({}, "", next);
  if (result === "ok") await refreshUser();
  return result;
}
