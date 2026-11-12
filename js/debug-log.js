const DBG_KEY = "dbg-playlist-player";

/** @param {string} hypothesisId @param {string} location @param {string} message @param {Record<string, unknown>} [data] */
export function debugBg(hypothesisId, location, message, data = {}) {
  const entry = {
    sessionId: "playlist-player",
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
  };
  try {
    const buf = JSON.parse(sessionStorage.getItem(DBG_KEY) || "[]");
    buf.push(entry);
    if (buf.length > 250) buf.splice(0, buf.length - 250);
    sessionStorage.setItem(DBG_KEY, JSON.stringify(buf));
  } catch {}
}

export function readBgDebugLog() {
  try {
    return JSON.parse(sessionStorage.getItem(DBG_KEY) || "[]");
  } catch {
    return [];
  }
}

export function clearBgDebugLog() {
  try {
    sessionStorage.removeItem(DBG_KEY);
  } catch {}
}
