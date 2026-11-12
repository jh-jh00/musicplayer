import { searchYouTube, searchErrorMessage } from "./youtube-api.js";
import { bindForegroundOnlyPlayback, canPlayInCurrentVisibility } from "./background-audio.js";

const STORAGE_KEYS = ["yt_player_v4", "yt_player_v3"];
const params = new URLSearchParams(location.search);

let player = null;
let youtubeReady = false;
let currentItem = null;
let currentIndex = -1;
let playlist = { name: "다음 영상", items: [] };
let toastTimer = 0;
let searchItems = [];
let searchQuery = "";
let searchNextPageToken = "";
let searchRequestId = 0;

const $ = (id) => document.getElementById(id);

function readState() {
  for (const key of STORAGE_KEYS) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "null");
      if (value && Array.isArray(value.playlists)) return value;
    } catch {
      // Ignore malformed old local data and try the next storage key.
    }
  }
  return null;
}

function readPlaylist(state) {
  if (!state) return { name: "다음 영상", items: [], cur: 0 };
  if (state.playbackSource === "waiting" && state.waitingQueue?.items?.length) {
    return { name: "다음 재생", ...state.waitingQueue };
  }
  const active = state.playlists.find((row) => row.id === state.activePlaylistId);
  return active?.items?.length ? active : { name: "다음 영상", items: [], cur: 0 };
}

function normalizeItem(item) {
  if (!item?.vid) return null;
  return {
    vid: String(item.vid),
    title: item.title || "YouTube 영상",
    artist: item.artist || "YouTube",
    art: item.art || `https://img.youtube.com/vi/${item.vid}/mqdefault.jpg`,
  };
}

function parseVideoId(raw) {
  const value = String(raw || "").trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (url.hostname === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] || "";
    if (url.hostname.endsWith("youtube.com")) {
      if (url.searchParams.get("v")) return url.searchParams.get("v");
      const parts = url.pathname.split("/").filter(Boolean);
      if (["embed", "shorts", "live"].includes(parts[0])) return parts[1] || "";
    }
  } catch {
    return "";
  }
  return "";
}

function showToast(message) {
  clearTimeout(toastTimer);
  const toast = $("watchToast");
  toast.textContent = message;
  toast.classList.add("show");
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1800);
}

function setSearchMode(active) {
  document.body.classList.toggle("search-mode", active);
  $("watchSearchResults").hidden = !active;
  if (!active) $("watchUrl").focus();
}

function renderSearchResults() {
  const grid = $("watchSearchGrid");
  grid.replaceChildren();
  $("watchSearchHeading").textContent = searchQuery || "YouTube";
  $("watchSearchStatus").textContent = searchItems.length ? `${searchItems.length}개의 영상` : "검색 결과가 없습니다.";

  searchItems.forEach((raw) => {
    const item = normalizeItem(raw);
    if (!item) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `watch-result-card${item.vid === currentItem?.vid ? " active" : ""}`;
    button.setAttribute("aria-label", `${item.title} 재생`);

    const media = document.createElement("span");
    media.className = "watch-result-media";
    const image = document.createElement("img");
    image.src = `https://i.ytimg.com/vi/${item.vid}/hqdefault.jpg`;
    image.alt = "";
    image.loading = "lazy";
    image.addEventListener("error", () => {
      if (image.src !== item.art) image.src = item.art;
    }, { once: true });
    const play = document.createElement("span");
    play.className = "watch-result-play";
    play.setAttribute("aria-hidden", "true");
    play.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7L8 5Z"/></svg>';
    media.append(image, play);

    const copy = document.createElement("span");
    copy.className = "watch-result-copy";
    const title = document.createElement("strong");
    title.textContent = item.title;
    const channel = document.createElement("span");
    channel.textContent = item.artist;
    copy.append(title, channel);
    button.append(media, copy);
    button.addEventListener("click", () => {
      selectItem(item, -1, 0, true);
      setSearchMode(true);
    });
    grid.append(button);
  });

  $("watchSearchMore").hidden = !searchNextPageToken;
}

async function runSearch(query, append = false) {
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) return;
  const requestId = ++searchRequestId;
  const pageToken = append ? searchNextPageToken : "";
  if (!append) {
    searchItems = [];
    searchQuery = normalizedQuery;
    searchNextPageToken = "";
    $("watchSearchGrid").replaceChildren();
  }
  setSearchMode(true);
  $("watchSearchHeading").textContent = normalizedQuery;
  $("watchSearchStatus").textContent = append ? "검색 결과를 더 불러오는 중..." : "검색 중...";
  $("watchSearchMore").hidden = true;
  $("watchUrl").blur();

  const { items, nextPageToken, error } = await searchYouTube(normalizedQuery, { limit: 18, pageToken });
  if (requestId !== searchRequestId) return;
  if (error) {
    $("watchSearchStatus").textContent = searchErrorMessage(error);
    $("watchSearchMore").hidden = !searchNextPageToken;
    showToast(searchErrorMessage(error));
    return;
  }
  const incoming = (items || []).map(normalizeItem).filter(Boolean);
  const known = new Set(searchItems.map((item) => item.vid));
  searchItems = append ? searchItems.concat(incoming.filter((item) => !known.has(item.vid))) : incoming;
  searchNextPageToken = nextPageToken || "";
  renderSearchResults();
}

async function fetchItem(vid) {
  try {
    const response = await fetch(`api/youtube-videos?ids=${encodeURIComponent(vid)}`);
    if (!response.ok) return null;
    const data = await response.json();
    return normalizeItem(data.items?.[0]);
  } catch {
    return null;
  }
}

function loadYouTubeApi() {
  return new Promise((resolve) => {
    if (window.YT?.Player) {
      youtubeReady = true;
      resolve();
      return;
    }
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      youtubeReady = true;
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    document.head.append(script);
  });
}

function createPlayer(item, startSeconds = 0) {
  if (!youtubeReady || !item?.vid) return;
  $("watchEmpty").classList.add("hidden");
  if (player?.loadVideoById) {
    const load = canPlayInCurrentVisibility() ? "loadVideoById" : "cueVideoById";
    player[load]({ videoId: item.vid, startSeconds });
    return;
  }
  player = new YT.Player("watchPlayer", {
    width: "100%",
    height: "100%",
    videoId: item.vid,
    playerVars: {
      autoplay: canPlayInCurrentVisibility() ? 1 : 0,
      controls: 1,
      playsinline: 1,
      rel: 0,
      modestbranding: 1,
      fs: 1,
      start: Math.max(0, Math.floor(startSeconds)),
      origin: location.origin,
    },
    events: {
      onStateChange(event) {
        if (!canPlayInCurrentVisibility()) {
          if (event.data === YT.PlayerState.PLAYING || event.data === YT.PlayerState.BUFFERING) event.target.pauseVideo();
          return;
        }
        if (event.data === YT.PlayerState.ENDED) playNext();
      },
    },
  });
}

function updateMeta() {
  const item = currentItem;
  $("watchTitle").textContent = item?.title || "영상 시청";
  $("watchChannel").textContent = item?.artist || "Playlist Player";
  $("watchQueueLabel").textContent = playlist.items.length
    ? `${playlist.name} · ${Math.max(0, currentIndex + 1)} / ${playlist.items.length}`
    : "단독 영상";
  $("watchChannelAvatar").textContent = (item?.artist || "P").trim().slice(0, 1).toUpperCase();
  const youtubeUrl = item?.vid ? `https://www.youtube.com/watch?v=${item.vid}` : "https://www.youtube.com/";
  $("openYoutube").href = youtubeUrl;
  $("openYoutube").setAttribute("aria-disabled", item ? "false" : "true");
  $("copyWatchLink").disabled = !item;
  document.title = item?.title ? `${item.title} · Playlist Player` : "영상 시청 · Playlist Player";
}

function renderQueue() {
  const list = $("watchQueueList");
  list.replaceChildren();
  $("watchPlaylistName").textContent = playlist.name || "다음 영상";
  $("watchQueueCount").textContent = `${playlist.items.length}개`;
  $("watchQueueEmpty").classList.toggle("hidden", playlist.items.length > 0);

  playlist.items.forEach((raw, index) => {
    const item = normalizeItem(raw);
    if (!item) return;
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = `watch-queue-item${index === currentIndex ? " active" : ""}`;
    button.setAttribute("aria-current", index === currentIndex ? "true" : "false");

    const number = document.createElement("span");
    number.className = "watch-queue-index";
    number.textContent = String(index + 1);

    const image = document.createElement("img");
    image.className = "watch-queue-thumb";
    image.src = item.art;
    image.alt = "";
    image.loading = "lazy";

    const copy = document.createElement("span");
    copy.className = "watch-queue-copy";
    const title = document.createElement("strong");
    title.textContent = item.title;
    const artist = document.createElement("span");
    artist.textContent = item.artist;
    copy.append(title, artist);
    button.append(number, image, copy);
    button.addEventListener("click", () => selectItem(item, index, 0, true));
    li.append(button);
    list.append(li);
  });

  requestAnimationFrame(() => {
    list.querySelector(".watch-queue-item.active")?.scrollIntoView({ block: "nearest" });
  });
}

function updateUrl(item, startSeconds = 0) {
  const next = new URL(location.href);
  next.searchParams.set("v", item.vid);
  if (startSeconds > 0) next.searchParams.set("t", String(Math.floor(startSeconds)));
  else next.searchParams.delete("t");
  history.replaceState({ vid: item.vid }, "", next);
}

function selectItem(item, index = -1, startSeconds = 0, updateHistory = true) {
  currentItem = normalizeItem(item);
  currentIndex = index;
  if (!currentItem) return;
  if (updateHistory) updateUrl(currentItem, startSeconds);
  updateMeta();
  renderQueue();
  createPlayer(currentItem, startSeconds);
  if (!$("watchSearchResults").hidden) renderSearchResults();
}

function playNext() {
  if (!playlist.items.length) return;
  const nextIndex = currentIndex >= 0 && currentIndex < playlist.items.length - 1 ? currentIndex + 1 : 0;
  const item = normalizeItem(playlist.items[nextIndex]);
  if (item) selectItem(item, nextIndex, 0, true);
}

async function openInput(raw) {
  const vid = parseVideoId(raw);
  if (!vid) {
    await runSearch(raw);
    return;
  }
  setSearchMode(false);
  const index = playlist.items.findIndex((item) => item?.vid === vid);
  if (index >= 0) {
    selectItem(playlist.items[index], index, 0, true);
    return;
  }
  const item = (await fetchItem(vid)) || normalizeItem({ vid });
  selectItem(item, -1, 0, true);
}

async function copyCurrentLink() {
  if (!currentItem) return;
  const url = new URL(location.href);
  url.searchParams.set("v", currentItem.vid);
  url.searchParams.delete("t");
  try {
    await navigator.clipboard.writeText(url.toString());
    showToast("시청 링크를 복사했습니다.");
  } catch {
    showToast("링크를 복사하지 못했습니다.");
  }
}

async function boot() {
  bindForegroundOnlyPlayback(() => player?.pauseVideo?.());
  const state = readState();
  const storedPlaylist = readPlaylist(state);
  playlist = {
    name: storedPlaylist.name || "다음 영상",
    items: (storedPlaylist.items || []).map(normalizeItem).filter(Boolean),
  };
  $("watchSearch").addEventListener("submit", (event) => {
    event.preventDefault();
    openInput($("watchUrl").value);
  });
  $("closeWatchSearch").addEventListener("click", () => setSearchMode(false));
  $("watchSearchMore").addEventListener("click", () => runSearch(searchQuery, true));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("watchSearchResults").hidden) setSearchMode(false);
  });
  $("copyWatchLink").addEventListener("click", copyCurrentLink);
  renderQueue();
  updateMeta();

  await loadYouTubeApi();
  const requestedVid = parseVideoId(params.get("v"));
  const storedCur = Math.max(0, Math.min(Number(storedPlaylist.cur) || 0, playlist.items.length - 1));
  const index = requestedVid ? playlist.items.findIndex((item) => item.vid === requestedVid) : storedCur;
  const startSeconds = Math.max(0, Number(params.get("t")) || 0);

  if (requestedVid && index < 0) {
    const item = (await fetchItem(requestedVid)) || normalizeItem({ vid: requestedVid });
    selectItem(item, -1, startSeconds, false);
  } else if (playlist.items.length) {
    selectItem(playlist.items[Math.max(0, index)], Math.max(0, index), startSeconds, false);
  }
}

boot();
