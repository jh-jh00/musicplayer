// 키를 여러 개 둘 수 있다. 앞에서부터 쓰고, 오늘치 할당량이 바닥난 키는 건너뛴다.
//   YOUTUBE_API_KEY, YOUTUBE_API_KEY_2, YOUTUBE_API_KEY_3, YOUTUBE_API_KEY_4
//   또는 YOUTUBE_API_KEYS 에 쉼표로 여러 개
export function getApiKeys(env) {
  const raw = [
    env.YOUTUBE_API_KEY,
    env.YOUTUBE_API_KEY_2,
    env.YOUTUBE_API_KEY_3,
    env.YOUTUBE_API_KEY_4,
    ...String(env.YOUTUBE_API_KEYS || "").split(","),
  ];
  const seen = new Set();
  const keys = [];
  for (const item of raw) {
    const key = String(item || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

export function requireApiKeys(env) {
  const keys = getApiKeys(env);
  if (!keys.length) {
    return {
      keys: [],
      error: Response.json({ error: "search_not_configured", items: [] }, { status: 503 }),
    };
  }
  return { keys, error: null };
}

// 오늘치가 바닥난 키. 이 isolate 가 살아 있는 동안만 기억한다 —
// 틀려도 다음 요청에서 한 번 더 시도해 볼 뿐이라 손해가 적다.
const exhaustedKeys = new Set();
const QUOTA_REASONS = new Set(["quotaExceeded", "dailyLimitExceeded"]);
const RETRY_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "backendError",
  "internalServerError",
]);

// 유튜브 호출은 전부 여기를 지난다. 키가 여러 개면 될 때까지 넘겨 가며 시도한다.
export async function youtubeFetch(keys, endpoint, params) {
  const list = Array.isArray(keys) ? keys : [keys];
  const fresh = list.filter((key) => !exhaustedKeys.has(key));
  const order = fresh.length ? fresh : list;
  let last = { error: "youtube_api_failed", data: null, status: 502 };

  for (const key of order) {
    const qs = new URLSearchParams(params);
    qs.set("key", key);
    const res = await fetch(`https://www.googleapis.com/youtube/v3/${endpoint}?${qs}`);
    const { error, data } = await readYouTubeJson(res);
    if (!error) return { error: null, data, status: res.status };

    last = { error, data, status: res.status };
    if (QUOTA_REASONS.has(error)) {
      exhaustedKeys.add(key);
      continue;
    }
    if (RETRY_REASONS.has(error)) continue;
    // 할당량·일시적 오류가 아니면 키를 바꿔도 결과가 같다.
    return last;
  }
  return last;
}

export function snippetToItem(snippet, vid) {
  const sn = snippet || {};
  const thumbs = sn.thumbnails || {};
  return {
    vid,
    title: sn.title || "유튜브 영상",
    artist: sn.channelTitle || "YouTube",
    art: thumbs.medium?.url || thumbs.default?.url || `https://img.youtube.com/vi/${vid}/mqdefault.jpg`,
  };
}

export async function readYouTubeJson(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = data?.error?.errors?.[0]?.reason || data?.error?.message || "youtube_api_failed";
    return { error: reason, data: null };
  }
  return { error: null, data };
}

export async function fetchPlaylistItemsApi(keys, listId, maxItems = 200) {
  let pageToken = "";
  const items = [];
  const seen = new Set();
  let title = "";
  let skipped = 0;
  let duplicates = 0;

  while (items.length < maxItems) {
    const params = new URLSearchParams({
      part: "snippet",
      playlistId: listId,
      maxResults: String(Math.min(50, maxItems - items.length)),
    });
    if (pageToken) params.set("pageToken", pageToken);

    const { error: apiError, data } = await youtubeFetch(keys, "playlistItems", params);
    if (apiError) return { error: apiError, items, title, skipped, duplicates };

    if (!title && data.items?.[0]?.snippet?.playlistTitle) {
      title = data.items[0].snippet.playlistTitle;
    }

    for (const row of data.items || []) {
      const kind = row.snippet?.resourceId?.kind;
      const vid = row.snippet?.resourceId?.videoId;
      const rowTitle = row.snippet?.title || "";
      if (kind && kind !== "youtube#video") {
        skipped += 1;
        continue;
      }
      if (!vid || rowTitle === "Private video" || rowTitle === "Deleted video") {
        skipped += 1;
        continue;
      }
      if (seen.has(vid)) {
        duplicates += 1;
        continue;
      }
      seen.add(vid);
      items.push(snippetToItem(row.snippet, vid));
      if (items.length >= maxItems) break;
    }

    pageToken = data.nextPageToken || "";
    if (!pageToken) break;
  }

  return { error: null, items, title, skipped, duplicates };
}

const HOUR = 3600;
const DAY = 24 * HOUR;

// 유튜브 호출 종류별 캐시 시간. 검색이 100유닛이라 오래 들고 있을수록 이득이 크다.
export const CACHE_TTL = {
  search: DAY,
  channelSearch: DAY,
  videoInfo: 7 * DAY, // 채널 사진·업로드 날짜는 거의 안 바뀐다
  channelVideos: 6 * HOUR, // 새 영상이 올라오므로 짧게
  trending: 3 * HOUR, // 인기 급상승은 자주 바뀐다
  subscriptions: 3 * HOUR, // 구독 피드도 마찬가지
};

// 표가 없을 때만 만든다(스키마를 아직 안 올린 환경 대비).
async function ensureCacheTable(db) {
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS api_cache (cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL)"
    )
    .run();
}

async function readCache(db, key, now) {
  const select = () =>
    db
      .prepare("SELECT payload FROM api_cache WHERE cache_key = ?1 AND expires_at > ?2")
      .bind(key, now)
      .first();
  try {
    return await select();
  } catch {
    // 표가 없어서 실패했을 수 있다. 한 번 만들어 보고 다시 읽는다.
    await ensureCacheTable(db);
    return select();
  }
}

function cachedJson(body, ttlSeconds) {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${ttlSeconds}`,
      "CDN-Cache-Control": `public, max-age=${ttlSeconds}`,
    },
  });
}

// 같은 요청을 두 곳에서 막는다.
//  1) 엣지 캐시 — 가장 빠르지만 지역별로 따로고 언제든 비워진다.
//  2) D1 — 느리지만 전 지역이 함께 쓰고 오래 남는다. 유튜브 할당량은 여기서 지켜진다.
// 응답 모양이 바뀌면 올린다 — 예전 캐시를 그대로 쓰면 새 필드가 빠진 채로 나온다.
const CACHE_NS = "v2";

// cacheKey 를 직접 주면 사용자별 캐시로 본다 — 엣지(공용)에는 올리지 않고 D1 에만 둔다.
export async function withSearchCache(request, env, buildResponse, ttlSeconds = DAY, cacheKey = null) {
  const url = new URL(request.url);
  const perUser = Boolean(cacheKey);
  const edge = caches.default;
  const edgeUrl = new URL(url);
  edgeUrl.searchParams.set("__c", CACHE_NS);
  const edgeKey = new Request(edgeUrl.toString(), { method: "GET" });
  const hit = perUser ? null : await edge.match(edgeKey);
  if (hit) return hit;

  const db = env?.youtube_player_db;
  const key = cacheKey ? `${CACHE_NS}:${cacheKey}` : `${CACHE_NS}:${url.pathname}${url.search}`;
  const now = Date.now();

  if (db) {
    try {
      const row = await readCache(db, key, now);
      if (row?.payload) {
        const response = cachedJson(row.payload, ttlSeconds);
        if (!perUser) await edge.put(edgeKey, response.clone());
        return response;
      }
    } catch {
      // 캐시가 안 되더라도 요청 자체는 살려 보낸다.
    }
  }

  const response = await buildResponse();
  if (!response.ok) return response;

  const body = await response.text();
  const cached = cachedJson(body, ttlSeconds);
  if (!perUser) await edge.put(edgeKey, cached.clone());

  if (db) {
    try {
      await db
        .prepare("INSERT OR REPLACE INTO api_cache (cache_key, payload, expires_at) VALUES (?1, ?2, ?3)")
        .bind(key, body, now + ttlSeconds * 1000)
        .run();
      // 가끔 지난 것들을 치운다.
      if (Math.random() < 0.02) {
        await db.prepare("DELETE FROM api_cache WHERE expires_at < ?1").bind(now).run();
      }
    } catch {
      // 저장 실패는 무시한다 — 다음 요청 때 다시 받으면 된다.
    }
  }

  return cached;
}

// ISO 8601 길이(PT1M30S)를 초로 바꾼다.
export function parseIsoDuration(iso) {
  const m = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso || "");
  if (!m) return 0;
  const [, d, h, min, s] = m;
  return (
    (Number(d) || 0) * 86400 +
    (Number(h) || 0) * 3600 +
    (Number(min) || 0) * 60 +
    Math.round(Number(s) || 0)
  );
}

// 목록의 각 영상에 재생 길이(sec)를 채워 준다. 롱폼/쇼츠를 가르는 데 쓴다.
// videos.list 는 50개당 1유닛이라 200개짜리 채널이어도 4유닛이면 끝난다.
export async function attachVideoDurations(keys, items) {
  const chunks = [];
  for (let i = 0; i < items.length; i += 50) chunks.push(items.slice(i, i + 50));

  await Promise.all(
    chunks.map(async (chunk) => {
      const params = new URLSearchParams({
        part: "contentDetails",
        id: chunk.map((row) => row.vid).join(","),
      });
      const { error, data } = await youtubeFetch(keys, "videos", params);
      if (error) return; // 길이를 못 받으면 그냥 비워 둔다 — 목록 자체는 보여 준다.
      const byId = new Map(
        (data.items || []).map((row) => [row.id, parseIsoDuration(row.contentDetails?.duration)])
      );
      chunk.forEach((row) => {
        const sec = byId.get(row.vid);
        if (sec) row.sec = sec;
      });
    })
  );

  return items;
}
