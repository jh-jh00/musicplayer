import {
  requireApiKeys,
  snippetToItem,
  youtubeFetch,
  withSearchCache,
  attachVideoDurations,
  CACHE_TTL,
} from "../_lib/youtube.js";
import { requireAccess } from "../_lib/access.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const auth = await requireAccess(request, env);
  if (auth.error) return auth.error;
  return withSearchCache(request, env, async () => {
    const { keys, error } = requireApiKeys(env);
    if (error) return error;

    const url = new URL(request.url);
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) {
      return Response.json({ error: "query_required", items: [] }, { status: 400 });
    }

    const maxResults = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 50);
    // 유튜브가 주는 길이 구간은 셋뿐이다 — short(4분 미만)·medium(4~20분)·long(20분 초과).
    // 쇼츠만 볼 때 short 를 넘기면 50개가 전부 4분 미만으로 와서 걸러낸 뒤 남는 게 훨씬 많다.
    const durationParam = (url.searchParams.get("duration") || "").trim();
    const videoDuration = ["short", "medium", "long"].includes(durationParam) ? durationParam : "";
    const pageToken = (url.searchParams.get("pageToken") || "").trim();

    const params = new URLSearchParams({
      part: "snippet",
      type: "video",
      q,
      maxResults: String(maxResults),
      safeSearch: "moderate",
    });
    if (pageToken) params.set("pageToken", pageToken);
    if (videoDuration) params.set("videoDuration", videoDuration);

    try {
      const { error: apiError, data, status } = await youtubeFetch(keys, "search", params);
      if (apiError) {
        return Response.json({ error: apiError, items: [] }, { status: status >= 400 ? status : 502 });
      }

      const items = (data.items || [])
        .map((row) => {
          const vid = row.id?.videoId;
          if (!vid || !row.snippet) return null;
          return snippetToItem(row.snippet, vid);
        })
        .filter(Boolean);

      // 롱폼/쇼츠를 가르려면 길이가 필요하다. 50개당 1유닛 — 검색 100유닛에 비하면 덤이다.
      await attachVideoDurations(keys, items);

      return Response.json({
        items,
        nextPageToken: data.nextPageToken || null,
      });
    } catch {
      return Response.json({ error: "network_error", items: [] }, { status: 502 });
    }
  }, CACHE_TTL.search);
}
