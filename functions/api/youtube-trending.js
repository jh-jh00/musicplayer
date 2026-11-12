import {
  requireApiKeys,
  youtubeFetch,
  withSearchCache,
  snippetToItem,
  parseIsoDuration,
  CACHE_TTL,
} from "../_lib/youtube.js";
import { requireAccess } from "../_lib/access.js";

// 인기 급상승. 로그인 없이도 되고 한 번에 1유닛이라 부담이 거의 없다.
export async function onRequestGet(context) {
  const { request, env } = context;
  const auth = await requireAccess(request, env);
  if (auth.error) return auth.error;

  return withSearchCache(
    request,
    env,
    async () => {
      const { keys, error } = requireApiKeys(env);
      if (error) return error;

      const url = new URL(request.url);
      const region = (url.searchParams.get("region") || "KR").trim().toUpperCase().slice(0, 2) || "KR";
      const maxResults = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 50);

      try {
        const params = new URLSearchParams({
          part: "snippet,contentDetails",
          chart: "mostPopular",
          regionCode: region,
          maxResults: String(maxResults),
        });
        const { error: apiError, data, status } = await youtubeFetch(keys, "videos", params);
        if (apiError) {
          return Response.json({ error: apiError, items: [] }, { status: status >= 400 ? status : 502 });
        }

        const items = (data.items || [])
          .map((row) => {
            const item = snippetToItem(row.snippet, row.id);
            const sec = parseIsoDuration(row.contentDetails?.duration);
            if (sec) item.sec = sec;
            return item;
          })
          .filter((item) => item.vid);

        return Response.json({ items, region });
      } catch {
        return Response.json({ error: "network_error", items: [] }, { status: 502 });
      }
    },
    CACHE_TTL.trending
  );
}
