import { requireApiKeys, snippetToItem, youtubeFetch } from "../_lib/youtube.js";
import { requireAccess } from "../_lib/access.js";

export async function onRequestGet({ request, env }) {
  const auth = await requireAccess(request, env);
  if (auth.error) return auth.error;
  const { keys, error } = requireApiKeys(env);
  if (error) return error;

  const url = new URL(request.url);
  const raw = url.searchParams.get("ids") || url.searchParams.get("id") || "";
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50);

  if (!ids.length) {
    return Response.json({ error: "ids_required", items: [] }, { status: 400 });
  }

  try {
    const params = new URLSearchParams({
      part: "snippet",
      id: ids.join(","),
    });
    const { error: apiError, data, status } = await youtubeFetch(keys, "videos", params);
    if (apiError) {
      return Response.json({ error: apiError, items: [] }, { status: status >= 400 ? status : 502 });
    }

    const items = (data.items || [])
      .map((row) => snippetToItem(row.snippet, row.id))
      .filter((item) => item.vid);

    return Response.json({ items });
  } catch {
    return Response.json({ error: "network_error", items: [] }, { status: 502 });
  }
}
