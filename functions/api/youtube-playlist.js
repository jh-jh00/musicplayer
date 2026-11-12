import { requireApiKeys, fetchPlaylistItemsApi } from "../_lib/youtube.js";
import { requireAccess } from "../_lib/access.js";

export async function onRequestGet({ request, env }) {
  const auth = await requireAccess(request, env);
  if (auth.error) return auth.error;
  const { keys, error } = requireApiKeys(env);
  if (error) return error;

  const url = new URL(request.url);
  const listId = (url.searchParams.get("list") || url.searchParams.get("id") || "").trim();
  if (!listId) {
    return Response.json({ error: "list_required", items: [], title: "" }, { status: 400 });
  }

  const maxItems = Math.min(Math.max(Number(url.searchParams.get("limit") || 200), 1), 500);

  try {
    const { error: apiError, items, title, skipped, duplicates } = await fetchPlaylistItemsApi(
      keys,
      listId,
      maxItems
    );
    if (apiError) {
      return Response.json({ error: apiError, items: [], title }, { status: 502 });
    }

    return Response.json({ items, title, listId, skipped, duplicates, truncated: items.length >= maxItems });
  } catch {
    return Response.json({ error: "network_error", items: [], title: "" }, { status: 502 });
  }
}
