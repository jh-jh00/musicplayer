import { requireApiKeys, youtubeFetch, withSearchCache, CACHE_TTL } from "../_lib/youtube.js";
import { requireAccess } from "../_lib/access.js";

// 영상 하나의 "시청 페이지용" 정보. 목록에 쓰는 /api/youtube-videos 와 달리
// 채널 프로필 사진·채널 ID·업로드 날짜까지 준다(요청당 유튜브 API 2회).
export async function onRequestGet(context) {
  const { request, env } = context;
  const auth = await requireAccess(request, env);
  if (auth.error) return auth.error;

  return withSearchCache(request, env, async () => {
    const { keys, error } = requireApiKeys(env);
    if (error) return error;

    const url = new URL(request.url);
    const id = (url.searchParams.get("id") || "").trim();
    if (!id) return Response.json({ error: "id_required" }, { status: 400 });

    try {
      const videoParams = new URLSearchParams({ part: "snippet", id });
      const { error: videoError, data: videoData, status } = await youtubeFetch(keys, "videos", videoParams);
      if (videoError) {
        return Response.json({ error: videoError }, { status: status >= 400 ? status : 502 });
      }

      const snippet = videoData?.items?.[0]?.snippet;
      if (!snippet) return Response.json({ error: "video_not_found" }, { status: 404 });

      const channelId = snippet.channelId || null;
      let channelArt = "";
      if (channelId) {
        const channelParams = new URLSearchParams({ part: "snippet", id: channelId });
        const { error: channelError, data: channelData } = await youtubeFetch(keys, "channels", channelParams);
        if (!channelError) {
          const thumbs = channelData?.items?.[0]?.snippet?.thumbnails || {};
          channelArt = thumbs.medium?.url || thumbs.default?.url || thumbs.high?.url || "";
        }
      }

      return Response.json({
        vid: id,
        title: snippet.title || "",
        channelId,
        channelTitle: snippet.channelTitle || "",
        publishedAt: snippet.publishedAt || "",
        channelArt,
      });
    } catch {
      return Response.json({ error: "network_error" }, { status: 502 });
    }
  }, CACHE_TTL.videoInfo);
}
