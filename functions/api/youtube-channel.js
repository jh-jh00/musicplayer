import {
  requireApiKeys,
  youtubeFetch,
  fetchPlaylistItemsApi,
  attachVideoDurations,
  withSearchCache,
  CACHE_TTL,
} from "../_lib/youtube.js";
import { requireAccess } from "../_lib/access.js";

async function resolveChannelId(keys, channelId, handle) {
  if (channelId) return channelId;

  const cleanHandle = (handle || "").replace(/^@/, "").trim();
  if (!cleanHandle) return null;

  const params = new URLSearchParams({
    part: "id",
    forHandle: cleanHandle,
  });
  const { error, data } = await youtubeFetch(keys, "channels", params);
  if (error) return null;
  return data.items?.[0]?.id || null;
}

export async function onRequestGet({ request, env }) {
  const auth = await requireAccess(request, env);
  if (auth.error) return auth.error;
  // 채널 하나를 열 때마다 유튜브 API 를 10유닛쯤 쓴다. 캐시로 막는다.
  return withSearchCache(request, env, () => buildChannelResponse(request, env), CACHE_TTL.channelVideos);
}

async function buildChannelResponse(request, env) {
  const { keys, error } = requireApiKeys(env);
  if (error) return error;

  const url = new URL(request.url);
  const channelId = (url.searchParams.get("channelId") || "").trim();
  const handle = (url.searchParams.get("handle") || "").trim();
  const maxItems = Math.min(Math.max(Number(url.searchParams.get("limit") || 200), 1), 500);

  const resolvedId = await resolveChannelId(keys, channelId, handle);
  if (!resolvedId) {
    return Response.json({ error: "channel_not_found", items: [], channelId: null }, { status: 404 });
  }

  try {
    const chParams = new URLSearchParams({
      part: "contentDetails,snippet",
      id: resolvedId,
    });
    const { error: chError, data: chData } = await youtubeFetch(keys, "channels", chParams);
    if (chError) {
      return Response.json({ error: chError, items: [], channelId: resolvedId }, { status: 502 });
    }

    const ch = chData?.items?.[0];
    const channelTitle = ch?.snippet?.title || "YouTube";
    const uploadsId = ch?.contentDetails?.relatedPlaylists?.uploads;

    if (!uploadsId) {
      return Response.json({ error: "uploads_not_found", items: [], channelId: resolvedId, channelTitle }, { status: 404 });
    }

    const { error: plError, items, title, skipped, duplicates } = await fetchPlaylistItemsApi(
      keys,
      uploadsId,
      maxItems
    );
    if (plError) {
      return Response.json({ error: plError, items: [], channelId: resolvedId, channelTitle }, { status: 502 });
    }

    // 롱폼/쇼츠를 가르려면 재생 길이가 필요하다. 50개당 1유닛.
    await attachVideoDurations(keys, items);

    return Response.json({
      items,
      channelId: resolvedId,
      channelTitle,
      uploadsPlaylistId: uploadsId,
      skipped,
      duplicates,
      truncated: items.length >= maxItems,
    });
  } catch {
    return Response.json({ error: "network_error", items: [], channelId: resolvedId }, { status: 502 });
  }
}
