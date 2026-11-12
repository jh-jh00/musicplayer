let searchConfigured = false;

const CACHE_TTL_MS = 30 * 60 * 1000;
// 응답에 담기는 항목이 바뀌면 올린다. 주소가 달라져야 브라우저가 물고 있는
// 예전 응답(예: 재생 길이가 없던 것) 대신 새로 받아 온다.
const API_SHAPE = "2";
const memCache = new Map();

export async function loadSearchConfig() {
  try {
    const res = await fetch("api/config");
    const j = await res.json();
    searchConfigured = Boolean(j.searchConfigured);
  } catch {
    searchConfigured = false;
  }
  return searchConfigured;
}

export function isSearchConfigured() {
  return searchConfigured;
}

function cacheGet(key) {
  const row = memCache.get(key);
  if (!row) return null;
  if (Date.now() > row.exp) {
    memCache.delete(key);
    return null;
  }
  return row.data;
}

function cacheSet(key, data) {
  memCache.set(key, { data, exp: Date.now() + CACHE_TTL_MS });
}

async function readJson(res) {
  const data = await res.json().catch(() => null);
  if (!res.ok) return { error: data?.error || (res.status === 429 ? "searchTooFrequent" : "request_failed"), data };
  if (!data || typeof data !== "object") return { error: "request_failed", data: null };
  return { error: null, data };
}

async function fetchCached(path, params) {
  const qs = params.toString();
  const key = `${path}?${qs}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  let parsed;
  try {
    parsed = await readJson(await fetch(`${path}?${qs}`));
  } catch {
    return { error: "network_error", data: null };
  }
  if (!parsed.error) cacheSet(key, parsed);
  return parsed;
}

export function searchErrorMessage(error, fallback = "검색 결과를 불러오지 못했습니다.") {
  if (error === "search_not_configured") return "YouTube 검색 설정을 확인해 주세요.";
  // 유튜브는 하루 검색 한도가 바닥나면 quotaExceeded 대신 rateLimitExceeded(429)를 주기도 한다.
  // 실제로 리셋(오후 5시) 뒤 검색 100번 남짓에서 끊기므로 둘 다 '오늘 한도 소진' 으로 안내한다.
  if (["quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded", "userRateLimitExceeded"].includes(error)) {
    return "오늘의 YouTube 검색 한도를 모두 사용했습니다. 매일 오후 5시에 다시 열립니다. 영상 URL 추가는 계속 쓸 수 있습니다.";
  }
  if (error === "searchTooFrequent") {
    return "검색을 너무 자주 했습니다. 1분 뒤 다시 시도해 주세요.";
  }
  if (error === "network_error") return "인터넷 연결을 확인하고 다시 시도해 주세요.";
  return fallback;
}

export async function fetchVideoMeta(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).slice(0, 50);
  if (!list.length) return { items: [], error: "ids_required" };
  const params = new URLSearchParams({ ids: list.join(",") });
  const { error, data } = await fetchCached("api/youtube-videos", params);
  return { items: data?.items || [], error };
}

export async function searchYouTube(query, { limit = 50, pageToken = "", duration = "" } = {}) {
  const q = (query || "").trim();
  if (!q) return { items: [], nextPageToken: null, error: "query_required" };
  const params = new URLSearchParams({ q, limit: String(limit), v: API_SHAPE });
  if (pageToken) params.set("pageToken", pageToken);
  if (duration) params.set("duration", duration);
  const { error, data } = await fetchCached("api/youtube-search", params);
  return {
    items: data?.items || [],
    nextPageToken: data?.nextPageToken || null,
    error,
  };
}

export async function searchChannels(query, { limit = 50, pageToken = "" } = {}) {
  const q = (query || "").trim();
  if (!q) return { channels: [], nextPageToken: null, error: "query_required" };
  const params = new URLSearchParams({ q, limit: String(limit) });
  if (pageToken) params.set("pageToken", pageToken);
  const { error, data } = await fetchCached("api/youtube-channels-search", params);
  return {
    channels: data?.channels || [],
    nextPageToken: data?.nextPageToken || null,
    error,
  };
}

export async function fetchPlaylistItems(listId, limit = 200) {
  if (!listId) return { items: [], title: "", error: "list_required", skipped: 0, duplicates: 0 };
  const params = new URLSearchParams({ list: listId, limit: String(limit) });
  const { error, data } = await fetchCached("api/youtube-playlist", params);
  return {
    items: data?.items || [],
    title: data?.title || "",
    truncated: Boolean(data?.truncated),
    skipped: data?.skipped ?? 0,
    duplicates: data?.duplicates ?? 0,
    error,
  };
}

export async function fetchChannelVideos({ channelId, handle } = {}, limit = 200) {
  const params = new URLSearchParams({ limit: String(limit), v: API_SHAPE });
  if (channelId) params.set("channelId", channelId);
  else if (handle) params.set("handle", handle.replace(/^@/, ""));
  else return { items: [], channelTitle: "", error: "channel_required" };

  const { error, data } = await fetchCached("api/youtube-channel", params);
  return {
    items: data?.items || [],
    channelId: data?.channelId || channelId || null,
    channelTitle: data?.channelTitle || "",
    truncated: Boolean(data?.truncated),
    skipped: data?.skipped ?? 0,
    duplicates: data?.duplicates ?? 0,
    error,
  };
}

export async function fetchWatchVideoInfo(vid) {
  const id = (vid || "").trim();
  if (!id) return { info: null, error: "id_required" };
  const params = new URLSearchParams({ id });
  const { error, data } = await fetchCached("api/youtube-video-info", params);
  if (error) return { info: null, error };
  return { info: data, error: null };
}

export async function fetchTrending({ region = "KR", limit = 50 } = {}) {
  const params = new URLSearchParams({ region, limit: String(limit), v: API_SHAPE });
  const { error, data } = await fetchCached("api/youtube-trending", params);
  return { items: data?.items || [], error };
}
