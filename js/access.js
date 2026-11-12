let accessState = { loggedIn: false, active: false, admin: false, publicAccess: false, expiresAt: null, remainingMs: 0 };
let accessListeners = new Set();

const api = (path, opts = {}) => fetch(path, { credentials: "include", ...opts });

export function getAccessState() {
  return { ...accessState };
}

export function onAccessChange(fn) {
  accessListeners.add(fn);
  fn(accessState);
  return () => accessListeners.delete(fn);
}

function notify() {
  accessListeners.forEach((fn) => fn(accessState));
}

export function formatRemaining(ms, unlimited = false) {
  if (unlimited || ms == null) return "무한";
  if (ms <= 0) return "만료됨";
  const totalMin = Math.ceil(ms / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}일 ${hours}시간`;
  if (hours > 0) return `${hours}시간 ${mins}분`;
  return `${mins}분`;
}

export async function refreshAccess() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await api("api/access/status", { signal: controller.signal });
    if (res.status === 401) {
      accessState = { loggedIn: false, active: false, admin: false, publicAccess: false, expiresAt: null, remainingMs: 0 };
    } else if (res.ok) {
      const data = await res.json();
      accessState = {
        loggedIn: Boolean(data.loggedIn),
        active: Boolean(data.active),
        admin: Boolean(data.admin),
        publicAccess: Boolean(data.publicAccess),
        unlimited: Boolean(data.unlimited),
        expiresAt: data.expiresAt ?? null,
        remainingMs: data.remainingMs ?? 0,
        code: data.code ?? null,
      };
    }
  } catch {
    // Keep the last confirmed status if the request temporarily fails.
  } finally {
    clearTimeout(timeout);
  }
  notify();
  return accessState;
}

export async function redeemCode(raw) {
  const res = await api("api/access/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: raw }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      data.error === "code_not_found"
        ? "코드를 찾을 수 없습니다."
        : data.error === "code_used"
          ? "이미 사용된 코드입니다."
          : data.error === "already_active"
            ? "이미 이용 중입니다."
            : "코드 등록에 실패했습니다.";
    throw new Error(msg);
  }
  await refreshAccess();
  return data;
}

export function canUseApp() {
  return accessState.active;
}
