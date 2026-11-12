import { requireApiKeys, youtubeFetch, withSearchCache, CACHE_TTL } from "../_lib/youtube.js";
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
      return Response.json({ error: "query_required", channels: [] }, { status: 400 });
    }

    const maxResults = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 50);
    const pageToken = (url.searchParams.get("pageToken") || "").trim();

    try {
      const params = new URLSearchParams({
        part: "snippet",
        type: "channel",
        q,
        maxResults: String(maxResults),
      });
      if (pageToken) params.set("pageToken", pageToken);

      const { error: apiError, data, status } = await youtubeFetch(keys, "search", params);
      if (apiError) {
        return Response.json({ error: apiError, channels: [] }, { status: status >= 400 ? status : 502 });
      }

      const channels = (data.items || [])
        .map((row) => {
          const id = row.id?.channelId;
          const sn = row.snippet;
          if (!id || !sn) return null;
          const thumbs = sn.thumbnails || {};
          return {
            channelId: id,
            title: sn.title || "채널",
            description: sn.description || "",
            art: thumbs.medium?.url || thumbs.default?.url || "",
          };
        })
        .filter(Boolean);

      return Response.json({
        channels,
        nextPageToken: data.nextPageToken || null,
      });
    } catch {
      return Response.json({ error: "network_error", channels: [] }, { status: 502 });
    }
  }, CACHE_TTL.channelSearch);
}
