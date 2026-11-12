import {
  getState,
  subscribe,
  ensureDefaultPlaylist,
  createPlaylist,
  deletePlaylist,
  renamePlaylist,
  setActivePlaylist,
  getActivePlaylist,
  getPlaybackPlaylist,
  getCurrentItem,
  resolveUrlsToItems,
  addUrlsToPlaylist,
  addItemsToPlaylist,
  addItemsToWaitingQueue,
  removeWaitingQueueItem,
  reorderWaitingQueueItem,
  clearWaitingQueue,
  searchWaitingQueue,
  getWaitingQueueAsPlaylist,
  getSubscriptions,
  isSubscribed,
  toggleSubscription,
  useWaitingQueuePlayback,
  isWaitingQueueActive,
  hasWaitingQueueItems,
  isQueuePlaybackMode,
  leaveQueuePlaybackMode,
  beginLibraryPlaybackSession,
  clearSessionQueue,
  setSessionQueue,
  ensureWaitingQueue,
  findItemIndex,
  removeItem,
  setCurrentIndex,
  searchItems,
  searchWatchHistory,
  clearWatchHistory,
  removeFromWatchHistory,
  getNowPlayingItem,
  patchState,
  setUiThemePreference,
} from "./playlists.js";
import {
  setProgressHandler,
  setPlayingChangeHandler,
  setTrackEndHandler,
  playIndex,
  togglePlay,
  togglePlaySync,
  pauseByUser,
  pauseForBackground,
  resumeByUser,
  resumeFromMediaSessionControl,
  warmPlayer,
  playNext,
  playPrev,
  toggleShuffle,
  cycleRepeat,
  setVolume,
  setVideoQuality,
  seekTo,
  getPlaybackProgress,
  applyMode,
  refreshVideoPlayerLayout,
  resumeIfPlaying,
  shouldResumeAfterVisible,
  shouldBgWatchdogResume,
  shouldKeepBgSessionAlive,
  getBgVirtualPausePosition,
  getBgPauseHoldPosition,
  ensureBgPauseAvSession,
  prepareForBackground,
  syncAudioOnForeground,
  initPlayerShell,
  isCoarsePointerDevice,
} from "./player.js";
import { initAuth, onAuthChange, signInWithGoogle, signOutUser, isConfigured, getUser, handleAuthRedirectQuery } from "./auth.js";
import { refreshAccess, redeemCode, canUseApp, onAccessChange, getAccessState, formatRemaining } from "./access.js";
import { syncOnLogin, syncOnLogout, hookAutoSync, getSyncLabel } from "./sync.js";
import { bindWithdrawUI, setWithdrawVisible } from "./withdraw.js";
import { initMediaSession, updateMediaSession, updateMediaPosition } from "./media-session.js";
import { initBackgroundPlayback, registerServiceWorker, startBackgroundKeepAlive, stopBackgroundKeepAlive, primeUserGestureAudio, isSilentKeepAliveActive, isSilentPauseOwnerActive } from "./background-audio.js";
import { debugBg, readBgDebugLog, clearBgDebugLog } from "./debug-log.js";
import {
  loadSearchConfig,
  isSearchConfigured,
  searchYouTube,
  searchErrorMessage,
  searchChannels,
  fetchChannelVideos,
  fetchWatchVideoInfo,
  fetchTrending,
} from "./youtube-api.js";
const BUILD_VERSION = "self-host-1";
const WATCH_APP_MODE = /\/watch\/?$/.test(location.pathname);

// /watch 홈에 띄우는 채널 프로필 사진·업로드 날짜. 영상당 한 번만 받아 온다.
const watchVideoMetaCache = new Map();
let watchMetaVid = null;
let watchChannelRef = null;

// 채널 화면에서 받아 온 영상 전체와, 지금 고른 종류(all/long/short).
let channelVideos = [];
let channelFilter = "all";
// 쇼츠 기준 — 유튜브가 쇼츠 여부를 안 알려 주므로 길이로 가른다.
const SHORTS_MAX_SEC = 120;
// 결과 화면이 채널 목록인지 검색 결과인지. 필터를 어떻게 다시 그릴지가 갈린다.
let resultsMode = "search";

const $ = (id) => document.getElementById(id);
let playing = false;
let lastProgressCur = 0;
let lastProgressDur = 0;
let progressScrubbing = false;
let scrubCommitted = false;
let lastWarmVid = "";
let detailPlaylistId = null;
let librarySearchQuery = "";
let addTab = "url";
let libTab = "playlists";
let waitingSearchQuery = "";
let searchBusy = false;
let searchKind = "video";
let searchNextToken = null;
let searchPendingItems = [];
let shownVideoIds = new Set();
let lastSearchQuery = "";
let historySearchQuery = "";
const HISTORY_PAGE_SIZE = 25;
let historyShownCount = HISTORY_PAGE_SIZE;
let homeQueueOpen = false;
let lastHomeQueueSig = "";
let queueDragSession = null;
let queueChoiceResolve = null;
let queueChoicePreviousFocus = null;
try {
  homeQueueOpen = localStorage.getItem("homeQueueOpen") === "true";
} catch {
  homeQueueOpen = false;
}

const scrollLoadState = new Map();

// IntersectionObserver 는 감시 대상이 root 안에 있어야 동작한다.
// 마크업에서는 감시용 요소가 목록 '바깥 형제' 라서 한 번도 안 걸렸다 —
// 목록 안으로 옮겨 준다. 목록을 innerHTML 로 비우면 사라지므로 없으면 새로 만든다.
function sentinelInside(id, root) {
  if (!root) return null;
  let sentinel = root.querySelector("#" + id);
  if (sentinel) return sentinel;
  sentinel = document.getElementById(id);
  if (!sentinel) {
    sentinel = document.createElement("li");
    sentinel.id = id;
    sentinel.setAttribute("aria-hidden", "true");
    sentinel.className = "scroll-sentinel hidden";
  }
  root.appendChild(sentinel);
  return sentinel;
}

function bindInfiniteScroll(key, { sentinel, root, hasMore, onLoad }) {
  scrollLoadState.get(key)?.disconnect?.();
  scrollLoadState.delete(key);

  if (!sentinel || !root || !hasMore()) {
    sentinel?.classList.add("hidden");
    sentinel?.classList.remove("is-loading");
    return;
  }

  sentinel.classList.remove("hidden");
  let loading = false;

  const run = async () => {
    if (loading || !hasMore()) {
      if (!hasMore()) bindInfiniteScroll(key, { sentinel, root, hasMore, onLoad });
      return;
    }
    loading = true;
    sentinel.classList.add("is-loading");
    try {
      await onLoad();
    } finally {
      loading = false;
      sentinel.classList.remove("is-loading");
      bindInfiniteScroll(key, { sentinel, root, hasMore, onLoad });
      if (hasMore()) {
        requestAnimationFrame(() => {
          const rect = sentinel.getBoundingClientRect();
          const rootRect = root.getBoundingClientRect();
          if (rect.top <= rootRect.bottom + 100) run();
        });
      }
    }
  };

  const observer = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting) run();
    },
    { root, rootMargin: "100px", threshold: 0 }
  );
  observer.observe(sentinel);

  // IntersectionObserver 는 화면이 그려지는 동안에만 돈다(배경 탭·숨은 창에서는 안 걸린다).
  // 스크롤로도 확인해서 목록이 중간에 멈추지 않게 한다.
  const onScroll = () => {
    if (root.scrollTop + root.clientHeight >= root.scrollHeight - 150) run();
  };
  root.addEventListener("scroll", onScroll, { passive: true });

  scrollLoadState.set(key, {
    disconnect: () => {
      observer.disconnect();
      root.removeEventListener("scroll", onScroll);
      sentinel.classList.remove("is-loading");
    },
  });
}

function disconnectInfiniteScroll(key) {
  scrollLoadState.get(key)?.disconnect?.();
  scrollLoadState.delete(key);
}

function fmt(t) {
  t = Math.max(0, Math.floor(t || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

const PROGRESS_RANGE_STEPS = 1000;

function ratioFromRangeValue(value) {
  return Math.max(0, Math.min(1, Number(value) / PROGRESS_RANGE_STEPS));
}

function syncRangeFromProgress(cur, dur) {
  const range = $("musicRange");
  if (!range || progressScrubbing) return;
  range.value = dur ? String(Math.round((cur / dur) * PROGRESS_RANGE_STEPS)) : "0";
}

function setProgressUI(cur, dur) {
  lastProgressCur = cur;
  lastProgressDur = dur;
  $("musicCur").textContent = fmt(cur);
  $("musicDur").textContent = fmt(dur);
  const pct = dur ? (cur / dur) * 100 : 0;
  $("musicFill").style.width = `${pct}%`;
  $("musicBarHit")?.classList.toggle("has-track", dur > 0);
  const range = $("musicRange");
  if (range) range.disabled = !dur;
  syncRangeFromProgress(cur, dur);
}

function previewProgressScrub(ratio) {
  const dur = lastProgressDur || getPlaybackProgress().dur;
  if (!dur) return;
  const previewCur = dur * ratio;
  $("musicCur").textContent = fmt(previewCur);
  $("musicFill").style.width = `${ratio * 100}%`;
}

function ensureProgressDuration() {
  if (lastProgressDur > 0) return true;
  const { cur, dur } = getPlaybackProgress();
  if (dur > 0) {
    setProgressUI(cur, dur);
    return true;
  }
  return false;
}

function setProgressGrabVisual(active) {
  $("musicBarHit")?.classList.toggle("is-grabbing", active);
  $("musicBar")?.classList.toggle("is-scrubbing", active);
}

function bindProgressBar() {
  const range = $("musicRange");
  const hit = $("musicBarHit");
  if (!range || !hit) return;

  const finishScrubInteraction = () => {
    if (progressScrubbing && !scrubCommitted) {
      scrubCommitted = true;
      const ratio = ratioFromRangeValue(range.value);
      seekTo(ratio);
      if (playing) updateMediaPosition({ duration: lastProgressDur, position: lastProgressCur });
    }
    progressScrubbing = false;
    setProgressGrabVisual(false);
    range.blur();
  };

  const startScrub = (e) => {
    if (!ensureProgressDuration()) return;
    progressScrubbing = true;
    scrubCommitted = false;
    setProgressGrabVisual(true);
    if (e?.pointerId != null && range.setPointerCapture) {
      try {
        range.setPointerCapture(e.pointerId);
      } catch {}
    }
  };

  range.addEventListener("pointerdown", startScrub);
  range.addEventListener("mousedown", startScrub);

  range.addEventListener("input", () => {
    if (!progressScrubbing) startScrub();
    const ratio = ratioFromRangeValue(range.value);
    previewProgressScrub(ratio);
  });

  range.addEventListener("change", finishScrubInteraction);
  range.addEventListener("pointerup", finishScrubInteraction);
  range.addEventListener("pointercancel", finishScrubInteraction);
  range.addEventListener("mouseup", finishScrubInteraction);
  range.addEventListener("touchend", finishScrubInteraction, { passive: true });
  range.addEventListener("touchcancel", finishScrubInteraction, { passive: true });
  range.addEventListener("blur", finishScrubInteraction);

  hit.addEventListener("pointerup", finishScrubInteraction);
  hit.addEventListener("touchend", finishScrubInteraction, { passive: true });
}

let maxQualityTipShown = false;

const MAX_QUALITY_TIP =
  "YouTube 플레이어 톱니바퀴에서 화질을 한 번 선택하면, 페이지를 나가기 전까지 그 화질로 유지됩니다.";

function toast(msg, durationMs = 1800) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("is-long", durationMs > 2000);
  el.classList.add("is-visible");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.classList.remove("is-visible", "is-long");
  }, durationMs);
}

function closeQueueChoiceDialog(choice = null) {
  const dialog = $("queueChoiceDialog");
  dialog?.classList.add("hidden");
  const resolve = queueChoiceResolve;
  queueChoiceResolve = null;
  if (queueChoicePreviousFocus?.focus) {
    try {
      queueChoicePreviousFocus.focus();
    } catch {}
  }
  queueChoicePreviousFocus = null;
  resolve?.(choice);
}

function showQueueChoiceDialog({ playlistName = "", count = 0, shuffled = false } = {}) {
  const dialog = $("queueChoiceDialog");
  const desc = $("queueChoiceDesc");
  if (!dialog) return Promise.resolve("append");
  if (queueChoiceResolve) closeQueueChoiceDialog(null);

  const safeName = playlistName || "선택한 재생목록";
  if (desc) {
    desc.textContent = shuffled
      ? `이미 담긴 곡들이 있습니다. ${safeName}의 ${count}곡을 섞어서 어떻게 담을까요?`
      : `이미 담긴 곡들이 있습니다. ${safeName}의 ${count}곡을 어떻게 담을까요?`;
  }

  if (desc) {
    const readableName = playlistName || "\uC120\uD0DD\uD55C \uC7AC\uC0DD\uBAA9\uB85D";
    const shuffleText = shuffled ? "\uC11E\uC5B4\uC11C " : "";
    desc.textContent =
      "\uC774\uBBF8 \uB2F4\uAE34 \uACE1\uB4E4\uC774 \uC788\uC2B5\uB2C8\uB2E4. " +
      `${readableName}\uC758 ${count}\uACE1\uC744 ${shuffleText}\uC5B4\uB5BB\uAC8C \uB2F4\uC744\uAE4C\uC694?`;
  }

  queueChoicePreviousFocus = document.activeElement;
  dialog.classList.remove("hidden");
  requestAnimationFrame(() => {
    dialog.querySelector('[data-queue-choice="append"]')?.focus();
  });

  return new Promise((resolve) => {
    queueChoiceResolve = resolve;
  });
}

function bindQueueChoiceDialog() {
  const dialog = $("queueChoiceDialog");
  if (!dialog) return;

  dialog.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-queue-choice]");
    if (btn) {
      const choice = btn.dataset.queueChoice;
      closeQueueChoiceDialog(choice === "cancel" ? null : choice);
      return;
    }
    if (e.target === dialog) closeQueueChoiceDialog(null);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || dialog.classList.contains("hidden")) return;
    closeQueueChoiceDialog(null);
  });
}

function formatItemsAddedMessage(
  added,
  { skippedUnavailable = 0, importDuplicates = 0, skippedDuplicate = 0, truncated = false } = {}
) {
  const notes = [];
  if (skippedUnavailable) notes.push(`가져올 수 없음 ${skippedUnavailable}곡`);
  if (importDuplicates) notes.push(`원본 중복 ${importDuplicates}곡`);
  if (skippedDuplicate) notes.push(`이미 있음 ${skippedDuplicate}곡`);
  if (truncated) notes.push("500곡 한도");
  const suffix = notes.length ? ` (${notes.join(", ")})` : "";
  return `${added}곡 추가${suffix}`;
}

function maybeShowMaxQualityTip() {
  if (maxQualityTipShown) return;
  if (!isCoarsePointerDevice()) return;
  if (getState().activeMode !== "video") return;
  if ((getState().videoQuality || "auto") === "auto") return;
  maxQualityTipShown = true;
  toast(MAX_QUALITY_TIP, 6000);
}

function isHomeScreenActive() {
  return document.querySelector(".screen-active")?.dataset.screen === "home";
}

function updateMiniVisibility() {
  const mini = $("miniPlayer");
  const has = Boolean(getNowPlayingItem());
  mini?.classList.toggle("is-visible", has && !isHomeScreenActive());
}

function showScreen(name, { watchSearch = false } = {}) {
  if (name !== "home") pauseForBackground();
  const searchView = WATCH_APP_MODE && watchSearch && name === "add";
  const drawerName = WATCH_APP_MODE && name !== "home" && !searchView ? name : null;
  const overlayName = searchView ? "add" : drawerName;
  document.querySelectorAll(".screen").forEach((s) => {
    const active = WATCH_APP_MODE ? s.dataset.screen === "home" || s.dataset.screen === overlayName : s.dataset.screen === name;
    s.classList.toggle("screen-active", active);
  });
  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.nav === (searchView ? "home" : name));
  });
  if (name === "reco") void renderRecoScreen();
  document.documentElement.classList.toggle("watch-search-view", searchView);
  document.documentElement.classList.toggle("watch-search-has-player", searchView && Boolean(getNowPlayingItem()?.vid));
  document.documentElement.classList.toggle("watch-drawer-open", Boolean(drawerName));
  const backdrop = $("watchDrawerBackdrop");
  if (backdrop) backdrop.classList.toggle("hidden", !drawerName);
  updateMiniVisibility();
}

function renderModeUI() {
  const mode = getState().activeMode;
  document.querySelectorAll(".mode-segment-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
  $("modeIndicator")?.classList.toggle("mode-video", mode === "video");
  const showVideo = mode === "video" || Boolean(getNowPlayingItem()?.vid);
  $("homeMusic")?.classList.toggle("is-active", !showVideo);
  $("homeVideo")?.classList.toggle("is-active", showVideo);
  $("watchLaunchRow")?.classList.toggle("hidden", WATCH_APP_MODE || mode !== "video");
  if ($("btnOpenWatch")) $("btnOpenWatch").disabled = !getNowPlayingItem()?.vid;
}

function normalizePlaybackMode(mode) {
  return mode === "video" ? "video" : "music";
}

function normalizeUiTheme(theme) {
  return theme === "ipod" || theme === "gameboy" ? theme : "default";
}

function applyUiTheme(theme = getState().uiTheme) {
  const value = normalizeUiTheme(theme);
  document.documentElement.dataset.uiTheme = value;
  document.documentElement.classList.toggle("ui-ipod", value === "ipod");
  document.documentElement.classList.toggle("ui-gameboy", value === "gameboy");
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    "content",
    value === "ipod" ? "#e7e4dc" : value === "gameboy" ? "#d7d3c3" : "#0f0f0f"
  );
}

function getDefaultPlaybackMode() {
  if (WATCH_APP_MODE) return "video";
  return normalizePlaybackMode(getState().defaultMode || "music");
}

function getCurrentPlaybackMode() {
  if (WATCH_APP_MODE) return "video";
  return normalizePlaybackMode(getState().activeMode || getState().defaultMode);
}

function trackArtBackground(item) {
  if (!item?.vid) return "none";
  const url = item.art || `https://img.youtube.com/vi/${item.vid}/mqdefault.jpg`;
  return `url(${url})`;
}

async function setPlaybackMode(mode, { asDefault = false } = {}) {
  const nextMode = normalizePlaybackMode(mode);
  if (asDefault) patchState({ defaultMode: nextMode });
  await applyMode(nextMode);
  renderModeUI();
  refreshVideoPlayerLayout();
}

function syncMediaSession() {
  const item = getNowPlayingItem();
  const silentPrimary = false;
  // fix66: stability first. Do not fake MediaSession "playing" while paused.
  const silentSystemPlaying = false;
  const systemPlaying = playing;
  const holdPos = getBgPauseHoldPosition();
  updateMediaSession({
    title: item?.title || "Playlist Player",
    artist: item?.artist || "",
    art: item?.art || "",
    playing,
    appPlaying: playing,
    systemPlaying,
    virtualPause: false,
    silentPrimary,
    silentMsPlaying: silentSystemPlaying,
  });
  if (lastProgressDur > 0) {
    updateMediaPosition({
      duration: lastProgressDur,
      position: holdPos ?? lastProgressCur,
      rate: silentSystemPlaying ? 0.000001 : 1,
    });
  }
}

function isHiddenSilentMediaSessionPinned() {
  return (
    document.visibilityState !== "visible" &&
    !playing &&
    (isSilentPauseOwnerActive() || isSilentKeepAliveActive())
  );
}

function bindPlayControl(btn) {
  if (!btn) return;
  let suppressClick = false;

  btn.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType === "mouse") return;
      suppressClick = false;
      if (btn.id === "miniPlayBtn") showScreen("home");
      primeUserGestureAudio();
      if (togglePlaySync() !== null) suppressClick = true;
    },
    { passive: true }
  );

  btn.addEventListener(
    "touchend",
    (e) => {
      if (!suppressClick) return;
      e.preventDefault();
    },
    { passive: false }
  );

  btn.onclick = (e) => {
    if (suppressClick) {
      suppressClick = false;
      e.preventDefault();
      return;
    }
    if (btn.id === "miniPlayBtn") showScreen("home");
    void togglePlay();
  };
}

function setPlayButtons(isPlaying) {
  [$("btnPlay"), $("miniPlayBtn")].forEach((btn) => {
    if (!btn) return;
    btn.classList.toggle("is-playing", isPlaying);
    btn.setAttribute("aria-label", isPlaying ? "일시정지" : "재생");
  });
}

function setRepeatButton(repeat) {
  const btn = $("btnRepeat");
  if (!btn) return;
  btn.classList.toggle("repeat-one", repeat === "one");
  btn.classList.toggle("active", repeat !== "off");
}

function decodeHtml(text) {
  if (!text) return "";
  const el = document.createElement("textarea");
  el.innerHTML = text;
  return el.value;
}

function formatWatchUploadDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}. ${date.getMonth() + 1}. ${date.getDate()}.`;
}

function applyWatchVideoMeta(info) {
  if (!info) return;
  const avatar = $("watchHomeChannelAvatar");
  if (avatar && info.channelArt) {
    // 사진이 실제로 떠야 이니셜을 감춘다 — 안 그러면 빈 회색 동그라미만 남는다.
    const photo = new Image();
    photo.onload = () => {
      if (watchMetaVid !== info.vid) return;
      avatar.style.backgroundImage = `url(${info.channelArt})`;
      avatar.classList.add("has-photo");
    };
    photo.src = info.channelArt;
  }
  if (info.channelTitle && $("watchHomeChannel")) {
    $("watchHomeChannel").textContent = info.channelTitle;
  }
  const uploaded = formatWatchUploadDate(info.publishedAt);
  if (uploaded && $("watchHomeQueueLabel")) {
    $("watchHomeQueueLabel").textContent = uploaded;
  }
  watchChannelRef = info.channelId
    ? { channelId: info.channelId, title: info.channelTitle || "채널" }
    : null;
  if ($("watchHomeChannelBtn")) $("watchHomeChannelBtn").disabled = !watchChannelRef;
  updateWatchTitleShield();
}

function clearWatchVideoMeta() {
  watchChannelRef = null;
  const avatar = $("watchHomeChannelAvatar");
  if (avatar) {
    avatar.style.backgroundImage = "";
    avatar.classList.remove("has-photo");
  }
  if ($("watchHomeChannelBtn")) $("watchHomeChannelBtn").disabled = true;
  updateWatchTitleShield();
}

async function loadWatchVideoMeta(vid) {
  const { info } = await fetchWatchVideoInfo(vid);
  if (!info) return;
  watchVideoMetaCache.set(vid, info);
  // 받아 오는 사이에 다른 영상으로 넘어갔으면 버린다.
  if (watchMetaVid !== vid) return;
  applyWatchVideoMeta(info);
}

function syncWatchVideoMeta(vid) {
  if (vid !== watchMetaVid) {
    watchMetaVid = vid;
    hideWatchEndScreen();
    clearWatchVideoMeta();
    if (!vid) return;
    const cached = watchVideoMetaCache.get(vid);
    if (cached) {
      applyWatchVideoMeta(cached);
      return;
    }
    void loadWatchVideoMeta(vid);
    return;
  }
  // 같은 영상인데 화면을 다시 그린 경우 — 방금 덮인 값을 되돌려 놓는다.
  if (vid && watchVideoMetaCache.has(vid)) applyWatchVideoMeta(watchVideoMetaCache.get(vid));
}

async function openWatchChannelView() {
  const ref = watchChannelRef;
  if (!ref?.channelId) return;
  addTab = "search";
  searchKind = "video";
  renderAddTabUI();
  renderSearchTypeUI();
  showScreen("add", { watchSearch: true });
  if ($("watchSearchResultsKind")) $("watchSearchResultsKind").textContent = "채널";
  if ($("watchSearchResultsTitle")) $("watchSearchResultsTitle").textContent = ref.title;
  await loadChannelVideos(ref);
}

// ── /watch 자체 종료 화면 ────────────────────────────────────────────
// 영상이 끝나면 유튜브 종료 화면(관련 영상 카드)이 그대로 남는데, 그걸 누르면
// 유튜브로 나가 버린다. iframe 안은 손댈 수 없으므로 그 위를 우리 화면으로 덮는다.
let watchEndScreenVid = null;

// styles.css 의 `.video-stage > div { width/height: 100% !important }` 이 직속 자식을
// 전부 화면 크기로 늘려 버린다. 그래서 겹칠 것들은 한 겹 안에 넣는다.
function watchStageLayer() {
  const stage = $("videoStage");
  if (!stage) return null;
  let layer = stage.querySelector(".watch-stage-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "watch-stage-layer";
    stage.appendChild(layer);
  }
  return layer;
}

function watchStageOverlay(className) {
  const layer = watchStageLayer();
  if (!layer) return null;
  let el = layer.querySelector("." + className);
  if (!el) {
    el = document.createElement("div");
    el.className = className + " hidden";
    layer.appendChild(el);
  }
  return el;
}

function hideWatchEndScreen() {
  watchEndScreenVid = null;
  watchStageOverlay("watch-endscreen")?.classList.add("hidden");
}

function watchEndScreenCard(row) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "watch-endscreen-card";
  const dur = row.sec ? `<span class="watch-endscreen-dur">${fmt(row.sec)}</span>` : "";
  card.innerHTML = `
    <span class="watch-endscreen-thumb" style="background-image:url(${row.art})">${dur}</span>
    <span class="watch-endscreen-card-title">${row.title}</span>`;
  card.onclick = () => {
    hideWatchEndScreen();
    void playStandaloneItem(row, "video");
  };
  return card;
}

async function showWatchEndScreen() {
  if (!WATCH_APP_MODE) return;
  const item = getNowPlayingItem();
  const el = watchStageOverlay("watch-endscreen");
  if (!el || !item?.vid) return;

  watchEndScreenVid = item.vid;
  const info = watchVideoMetaCache.get(item.vid) || null;
  const channelTitle = decodeHtml(info?.channelTitle || item.artist || "채널");
  const initial = (channelTitle || "P").trim().slice(0, 1).toUpperCase();
  const avatarClass = info?.channelArt ? "watch-endscreen-avatar has-photo" : "watch-endscreen-avatar";
  const avatarStyle = info?.channelArt ? `background-image:url(${info.channelArt})` : "";

  el.innerHTML = `
    <div class="watch-endscreen-top">
      <button class="watch-endscreen-channel" type="button">
        <span class="${avatarClass}" style="${avatarStyle}">${initial}</span>
        <span class="watch-endscreen-channel-name">${channelTitle}</span>
      </button>
      <button class="watch-endscreen-replay" type="button">
        <svg class="icon" aria-hidden="true"><use href="#icon-repeat"/></svg>
        <span>다시 재생</span>
      </button>
    </div>
    <p class="watch-endscreen-label"></p>
    <div class="watch-endscreen-cards"></div>`;
  el.classList.remove("hidden");

  el.querySelector(".watch-endscreen-replay").onclick = () => {
    hideWatchEndScreen();
    void playStandaloneItem(item, "video");
  };
  const channelBtn = el.querySelector(".watch-endscreen-channel");
  channelBtn.disabled = !info?.channelId;
  channelBtn.onclick = () => {
    hideWatchEndScreen();
    void openWatchChannelView();
  };

  const { label, items: picks } = await watchNextUpList(item, 4);
  if (watchEndScreenVid !== item.vid) return;
  const labelEl = el.querySelector(".watch-endscreen-label");
  if (labelEl) labelEl.textContent = label;
  const box = el.querySelector(".watch-endscreen-cards");
  if (!box || !picks.length) return;
  box.innerHTML = "";
  picks.forEach((row) => box.appendChild(watchEndScreenCard(row)));
}

// 플레이어 왼쪽 위 제목·채널 줄을 덮어, 유튜브로 나가는 대신 우리 채널 화면으로 보낸다.
// 영상이 끝나기 전 마지막 구간에는 유튜브 종료 화면 카드가 영상 위에 뜬다.
// 그 카드를 누르면 유튜브로 나가 버리므로, 그동안 화면을 투명 막으로 덮는다.
// 막을 누르면 재생/일시정지만 되고, 아래 재생바 줄은 덮지 않아 그대로 쓸 수 있다.
const WATCH_END_GUARD_SEC = 20;

// 시청 페이지에서는 영상이 끝나면 그냥 끝난다 — 혼자 되감아 다시 틀지 않는다.
// (반복 버튼 자체가 /watch 에서는 숨겨져 있어 사용자가 되돌릴 방법도 없다)
function forceWatchNoRepeat() {
  if (!WATCH_APP_MODE) return;
  const wq = getState().waitingQueue;
  if (wq && wq.repeat !== "off") patchState({ waitingQueue: { ...wq, repeat: "off" } });
  // 영상 하나를 틀면 `지금 재생`(sessionQueue) 으로 잡히는데, 이쪽 repeat 이
  // 기본값 `전체 반복` 을 물려받아 혼자 되감기고 있었다.
  const sq = getState().sessionQueue;
  if (sq?.items?.length && sq.repeat !== "off") {
    patchState({ sessionQueue: { ...sq, repeat: "off" } });
  }
}

function updateWatchEndGuard(cur, dur) {
  if (!WATCH_APP_MODE) return;
  const guard = watchStageOverlay("watch-endguard");
  if (!guard) return;
  if (!guard.dataset.bound) {
    guard.dataset.bound = "1";
    guard.onclick = () => {
      void togglePlay();
    };
  }
  const remain = Number(dur) - Number(cur);
  const on = dur > 0 && remain > 0 && remain <= WATCH_END_GUARD_SEC;
  guard.classList.toggle("hidden", !on);
}

function updateWatchTitleShield() {
  if (!WATCH_APP_MODE) return;
  const shield = $("videoStage")?.querySelector(".watch-title-shield");
  if (!shield) return;
  shield.style.pointerEvents = watchChannelRef?.channelId ? "auto" : "none";
}

function ensureWatchTitleShield() {
  if (!WATCH_APP_MODE) return;
  const shield = watchStageOverlay("watch-title-shield");
  if (!shield) return;
  shield.classList.remove("hidden");
  if (shield.dataset.bound) return;
  shield.dataset.bound = "1";
  shield.title = "채널 보기";
  shield.style.pointerEvents = "none";
  shield.onclick = () => {
    if (watchChannelRef?.channelId) void openWatchChannelView();
  };
  updateWatchTitleShield();
}

// 자동 재생 — 켜 두면 영상이 끝났을 때 같은 채널의 다음 영상을 바로 잇는다.
// 이때는 자체 종료 화면(이 채널의 다른 영상)을 띄우지 않는다.
const WATCH_AUTOPLAY_KEY = "watch_autoplay";
let watchAutoplayOn = false;
const watchAutoplayed = new Set();

function loadWatchAutoplay() {
  try {
    watchAutoplayOn = localStorage.getItem(WATCH_AUTOPLAY_KEY) === "1";
  } catch {
    watchAutoplayOn = false;
  }
  renderWatchAutoplay();
}

function renderWatchAutoplay() {
  const btn = $("btnWatchAutoplay");
  if (btn) btn.setAttribute("aria-checked", watchAutoplayOn ? "true" : "false");
}

function toggleWatchAutoplay() {
  watchAutoplayOn = !watchAutoplayOn;
  try {
    localStorage.setItem(WATCH_AUTOPLAY_KEY, watchAutoplayOn ? "1" : "0");
  } catch {}
  renderWatchAutoplay();
  if (watchAutoplayOn) hideWatchEndScreen();
  toast(watchAutoplayOn ? "자동 재생 켜짐" : "자동 재생 꺼짐");
}

async function playWatchAutoplayNext(item) {
  const { items } = await watchNextUpList(item, 1);
  const pick = items[0];
  if (!pick) return false;
  watchAutoplayed.add(pick.vid);
  await playStandaloneItem(pick, "video");
  return true;
}

// 다음에 볼 영상을 어디서 가져올지.
//  1) 우리 사이트에서 구독한 채널이 있으면 → 그 채널들의 새 영상
//  2) 없으면 → 인기 급상승
// 유튜브 계정 권한은 쓰지 않는다(민감 권한이라 검증 전에는 로그인 경고가 뜬다).
let watchRecoCache = null;
let viewedChannel = null;

// 구독한 채널들의 최근 영상을 모은다. 채널당 3개씩, 라운드로빈으로 섞는다.
// 채널 목록 요청은 6시간 캐시라 사용자가 늘어도 유튜브 호출은 늘지 않는다.
async function buildSubscriptionFeed() {
  const subs = getSubscriptions().slice(0, 20);
  if (!subs.length) return [];

  const lists = await Promise.all(
    subs.map(async (row) => {
      const { items } = await fetchChannelVideos({ channelId: row.channelId }, 10);
      return (items || []).slice(0, 3).map((item) => ({ ...item, artist: item.artist || row.title }));
    })
  );

  const seen = new Set();
  const out = [];
  for (let rank = 0; rank < 3; rank += 1) {
    for (const list of lists) {
      const item = list[rank];
      if (!item?.vid || seen.has(item.vid)) continue;
      seen.add(item.vid);
      out.push(item);
    }
  }
  return out;
}

async function loadWatchRecommendations() {
  if (watchRecoCache) return watchRecoCache;

  const feed = await buildSubscriptionFeed();
  if (feed.length) {
    watchRecoCache = { source: "subscriptions", label: "구독 채널의 새 영상", items: feed };
    return watchRecoCache;
  }

  const { items, error } = await fetchTrending({ region: "KR" });
  if (!error && items.length) {
    watchRecoCache = { source: "trending", label: "인기 급상승", items };
    return watchRecoCache;
  }
  return null;
}

// 지금 보는 영상·이미 튼 영상은 빼고 고른다.
function pickWatchReco(list, currentVid, count) {
  return (list || [])
    .filter((row) => row?.vid && row.vid !== currentVid && !watchAutoplayed.has(row.vid))
    .slice(0, count);
}

// 영상이 끝났을 때 이어서 볼 것은 `이 채널의 다른 영상` 이다.
// (구독 피드·인기 급상승은 왼쪽 `알고리즘` 탭에서 따로 본다)
async function watchNextUpList(item, count) {
  const info = watchVideoMetaCache.get(item.vid);
  if (!info?.channelId) return { label: "", items: [] };
  const { items } = await fetchChannelVideos({ channelId: info.channelId }, 200);
  return { label: "이 채널의 다른 영상", items: pickWatchReco(items, item.vid, count) };
}

// 채널 화면의 구독 버튼
function renderChannelSubscribeUI() {
  const btn = $("btnChannelSubscribe");
  if (!btn) return;
  const on = isSubscribed(viewedChannel?.channelId);
  btn.classList.toggle("hidden", !viewedChannel?.channelId);
  btn.classList.toggle("is-on", on);
  btn.textContent = on ? "구독중" : "구독";
}

function toggleViewedChannelSubscription() {
  if (!viewedChannel?.channelId) return;
  const on = toggleSubscription(viewedChannel);
  watchRecoCache = null;
  renderChannelSubscribeUI();
  toast(on ? `${viewedChannel.title} 구독` : `${viewedChannel.title} 구독 해제`);
}

// 알고리즘 탭 — 구독 피드(로그인 + 권한) 또는 인기 급상승을 보여 준다.
// 영상이 끝났을 때 뜨는 종료 화면은 이것과 별개로 `이 채널의 다른 영상` 을 쓴다.
function renderRecoList(items) {
  const ul = $("recoResults");
  if (!ul) return;
  ul.innerHTML = "";
  if (!items.length) {
    ul.innerHTML = '<li class="search-empty">보여 줄 영상이 없습니다.</li>';
    return;
  }
  items.forEach((item) => {
    const li = document.createElement("li");
    li.className = "search-result";
    li.innerHTML = `
      <div class="search-result-main">
        <span class="search-thumb" style="background-image:url(${item.art})"></span>
        <span class="search-meta">
          <span class="search-title">${item.title}</span>
          <span class="search-artist">${item.artist}</span>
        </span>
      </div>
      <div class="search-actions">
        <button class="search-action-btn" type="button" data-reco-play>재생</button>
        <button class="search-action-btn search-action-btn-accent" type="button" data-reco-queue>다음 재생</button>
      </div>`;
    li.querySelector("[data-reco-play]").onclick = () => {
      void playStandaloneItem(item, WATCH_APP_MODE ? "video" : getDefaultPlaybackMode());
    };
    li.querySelector("[data-reco-queue]").onclick = () => addItemToQueue(item);
    ul.appendChild(li);
  });
}

async function renderRecoScreen({ refresh = false } = {}) {
  const ul = $("recoResults");
  if (!ul) return;
  if (refresh) watchRecoCache = null;

  const hint = $("recoHint");
  if (hint) hint.classList.add("hidden");
  ul.innerHTML = '<li class="search-empty">불러오는 중...</li>';

  const reco = await loadWatchRecommendations();
  if (!reco) {
    ul.innerHTML = '<li class="search-empty">추천을 불러오지 못했습니다.</li>';
    return;
  }
  if ($("recoKind")) $("recoKind").textContent = reco.source === "subscriptions" ? "구독" : "인기 급상승";
  if ($("recoTitle")) $("recoTitle").textContent = reco.label;
  if (hint && reco.source !== "subscriptions") {
    hint.textContent = "채널 화면에서 구독하면 그 채널의 새 영상이 여기에 모입니다.";
    hint.classList.remove("hidden");
  }
  renderRecoList(reco.items);
}

// 자동 재생 스위치를 `다음 재생` 글자 바로 옆에 붙인다(글자 폭이 상황마다 달라 재어서 놓는다).
function positionWatchAutoplay() {
  if (!WATCH_APP_MODE) return;
  const box = $("watchAutoplay");
  const label = document.querySelector("#homeQueue .home-queue-toggle-label");
  const section = $("homeQueue");
  if (!box || !label || !section) return;
  const gap = label.getBoundingClientRect().right - section.getBoundingClientRect().left;
  if (gap > 0) {
    box.style.left = `${Math.round(gap) + 14}px`;
    box.style.right = "auto";
  }
}

function setWatchRail(open) {
  document.documentElement.classList.toggle("watch-rail-open", open);
  const btn = $("watchRailToggle");
  if (!btn) return;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  btn.setAttribute("aria-label", open ? "메뉴 닫기" : "메뉴 열기");
}

function renderNowPlaying() {
  const item = getNowPlayingItem();
  const wq = getState().waitingQueue;
  const has = Boolean(item);
  renderModeUI();
  if ($("btnOpenWatch")) $("btnOpenWatch").disabled = !item?.vid;
  updateMiniVisibility();

  const title = decodeHtml(item?.title || "재생할 곡을 선택하세요");
  const artist = decodeHtml(item?.artist || "보관함에서 재생목록을 고르거나 URL을 추가하세요");
  const art = trackArtBackground(item);

  $("trackTitle").textContent = title;
  $("trackArtist").textContent = artist;
  if ($("watchHomeChannel")) $("watchHomeChannel").textContent = artist;
  if ($("watchHomeChannelAvatar")) {
    $("watchHomeChannelAvatar").textContent = (artist || "P").trim().slice(0, 1).toUpperCase();
  }
  const playbackList = getPlaybackPlaylist();
  const playbackCount = playbackList?.items?.length || 0;
  const playbackIndex = playbackCount
    ? Math.max(0, playbackList.items.findIndex((row) => row?.vid === item?.vid))
    : -1;
  if ($("watchHomeQueueLabel")) {
    $("watchHomeQueueLabel").textContent = has
      ? playbackCount
        ? `${playbackList.name || "다음 영상"} · ${playbackIndex + 1} / ${playbackCount}`
        : "단독 영상"
      : "재생목록에서 영상을 선택하세요";
  }
  const youtubeUrl = item?.vid ? `https://www.youtube.com/watch?v=${item.vid}` : "https://www.youtube.com/";
  if ($("watchHomeYoutubeLink")) {
    $("watchHomeYoutubeLink").href = youtubeUrl;
    $("watchHomeYoutubeLink").setAttribute("aria-disabled", has ? "false" : "true");
  }
  if ($("watchHomeCopyLink")) $("watchHomeCopyLink").disabled = !has;
  if (WATCH_APP_MODE) syncWatchVideoMeta(item?.vid || null);
  if (WATCH_APP_MODE && document.documentElement.classList.contains("watch-search-view")) {
    // 검색 결과를 보는 중에 재생 영상이 바뀌면 오른쪽 아래 작은 화면(PiP)도 같이 켜고 끈다.
    document.documentElement.classList.toggle("watch-search-has-player", Boolean(item?.vid));
  }
  $("albumArt").style.backgroundImage = art;
  $("albumArt")?.classList.toggle("has-track", has);
  $("miniTitle").textContent = title;
  $("miniArtist").textContent = artist;
  $("miniArt").style.backgroundImage = art;

  $("btnShuffle")?.classList.toggle(
    "active",
    hasWaitingQueueItems() ? Boolean(wq?.shuffle) : Boolean(getActivePlaylist()?.shuffle)
  );
  setRepeatButton(
    isQueuePlaybackMode() && hasWaitingQueueItems()
      ? (wq?.repeat ?? "all")
      : (getActivePlaylist()?.repeat ?? getState().defaultRepeat ?? "all")
  );
  setPlayButtons(playing);
  syncMediaSession();
  if (item?.vid && item.vid !== lastWarmVid) {
    lastWarmVid = item.vid;
    void warmPlayer(item.vid);
  }
  syncHomeQueueAfterPlayback();
  if (libTab === "queue") renderLibraryQueue();
}

function renderPlaylistCards() {
  const ul = $("playlistCards");
  ul.innerHTML = "";
  getState().playlists.forEach((pl) => {
    const li = document.createElement("li");
    li.className = `playlist-card${pl.id === getState().activePlaylistId ? " active" : ""}`;
    li.innerHTML = `
      <div>
        <div class="playlist-card-name">${pl.name}</div>
        <div class="playlist-card-meta">${pl.items.length}곡</div>
      </div>
      <div class="playlist-card-actions">
        <button class="btn-icon" data-rename="${pl.id}" type="button" aria-label="이름 변경"><svg class="icon icon-sm"><use href="#icon-edit"/></svg></button>
        <button class="btn-icon" data-del="${pl.id}" type="button" aria-label="삭제"><svg class="icon icon-sm"><use href="#icon-delete"/></svg></button>
      </div>`;
    li.onclick = (e) => {
      if (e.target.closest("[data-rename]") || e.target.closest("[data-del]")) return;
      openPlaylistDetail(pl.id);
    };
    li.querySelector("[data-rename]").onclick = (e) => {
      e.stopPropagation();
      const name = prompt("재생목록 이름", pl.name);
      if (name) renamePlaylist(pl.id, name);
    };
    li.querySelector("[data-del]").onclick = (e) => {
      e.stopPropagation();
      if (confirm(`"${pl.name}" 목록을 삭제할까요?`)) deletePlaylist(pl.id);
    };
    ul.appendChild(li);
  });
}

function openPlaylistDetail(id) {
  detailPlaylistId = id;
  libTab = "playlists";
  const pl = getState().playlists.find((p) => p.id === id);
  if (!pl) return;
  $("libraryDetail").classList.remove("hidden");
  $("playlistCards").classList.add("hidden");
  $("detailPlaylistName").textContent = pl.name;
  renderLibraryTabUI();
  renderTrackList();
}

function closePlaylistDetail() {
  detailPlaylistId = null;
  $("libraryDetail").classList.add("hidden");
  $("playlistCards").classList.remove("hidden");
}

function renderLibraryTabUI() {
  document.querySelectorAll(".library-segment-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.libTab === libTab);
  });
  $("libraryPlaylists")?.classList.toggle("hidden", libTab !== "playlists");
  $("libraryQueue")?.classList.toggle("hidden", libTab !== "queue");
  $("libraryHistory")?.classList.toggle("hidden", libTab !== "history");
  $("btnNewPlaylist")?.classList.toggle("hidden", libTab !== "playlists");
  $("btnClearWaiting")?.classList.toggle("hidden", libTab !== "queue");
  $("btnClearHistory")?.classList.toggle("hidden", libTab !== "history");
  if (libTab !== "history") disconnectInfiniteScroll("history");
  if (libTab === "history" || libTab === "queue") closePlaylistDetail();
}

function resetHistoryPaging() {
  historyShownCount = HISTORY_PAGE_SIZE;
}

function bindHistoryScrollLoad(totalCount) {
  bindInfiniteScroll("history", {
    sentinel: sentinelInside("historyScrollSentinel", $("historyList")),
    root: $("historyList"),
    hasMore: () => libTab === "history" && totalCount > historyShownCount,
    onLoad: async () => {
      loadMoreHistory();
    },
  });
}

function appendHistoryRows(rows) {
  const ul = $("historyList");
  if (!ul) return;
  rows.forEach(({ item }) => {
    const li = document.createElement("li");
    li.className = "track-item track-item-card";
    const when = item.watchedAt
      ? new Date(item.watchedAt).toLocaleDateString("ko-KR", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";
    li.innerHTML = `
      <div class="track-item-main">
        <span class="track-thumb" style="background-image:url(${item.art})"></span>
        <span class="track-info">
          <div class="track-info-title">${item.title}</div>
          <div class="track-info-artist">${item.artist}${when ? ` · ${when}` : ""}</div>
        </span>
      </div>
      <div class="track-action-bar track-action-bar-history">
        <button class="search-action-btn" type="button" data-hist-play="music">음악</button>
        <button class="search-action-btn" type="button" data-hist-play="video">영상</button>
        <button class="search-action-btn search-action-btn-accent" type="button" data-hist-queue>다음 재생</button>
        <button class="search-action-btn search-action-btn-icon" type="button" data-hist-del aria-label="삭제"><svg class="icon icon-sm"><use href="#icon-close"/></svg></button>
      </div>`;
    li.querySelector('[data-hist-play="music"]').onclick = (e) => {
      e.stopPropagation();
      playStandaloneItem(item, "music");
    };
    li.querySelector('[data-hist-play="video"]').onclick = (e) => {
      e.stopPropagation();
      playStandaloneItem(item, "video");
    };
    li.querySelector("[data-hist-queue]").onclick = (e) => {
      e.stopPropagation();
      addItemToQueue(item);
    };
    li.querySelector("[data-hist-del]").onclick = (e) => {
      e.stopPropagation();
      removeFromWatchHistory(item.vid);
      toast("기록에서 삭제");
    };
    li.onclick = (e) => {
      if (e.target.closest(".track-action-bar")) return;
      playStandaloneItem(item, getDefaultPlaybackMode());
    };
    ul.appendChild(li);
  });
}

function renderHistoryList() {
  const ul = $("historyList");
  if (!ul) return;
  ul.innerHTML = "";
  const rows = searchWatchHistory(historySearchQuery);
  if (!rows.length) {
    resetHistoryPaging();
    ul.innerHTML = '<li class="track-item">시청 기록이 없습니다.</li>';
    bindHistoryScrollLoad(0);
    return;
  }
  if (historyShownCount > rows.length) historyShownCount = rows.length;
  appendHistoryRows(rows.slice(0, historyShownCount));
  bindHistoryScrollLoad(rows.length);
}

function loadMoreHistory() {
  const rows = searchWatchHistory(historySearchQuery);
  if (historyShownCount >= rows.length) return;
  const prev = historyShownCount;
  historyShownCount = Math.min(historyShownCount + HISTORY_PAGE_SIZE, rows.length);
  appendHistoryRows(rows.slice(prev, historyShownCount));
  bindHistoryScrollLoad(rows.length);
}

async function playItemNow(item, mode) {
  if (!item?.vid) return;

  if (isWaitingQueueActive()) {
    const pl = getWaitingQueueAsPlaylist();
    const inQueue = findItemIndex(pl, item.vid);
    if (inQueue >= 0) {
      useWaitingQueuePlayback();
      patchState({ activeMode: mode });
      await applyMode(mode);
      showScreen("home");
      await playIndex(inQueue, true);
      renderModeUI();
      renderHomeQueue();
      renderLibraryQueue();
      return;
    }
  }

  beginLibraryPlaybackSession(item.vid);
  clearSessionQueue();
  setSessionQueue([item], 0);
  patchState({ activeMode: mode });
  await applyMode(mode);
  showScreen("home");
  await playIndex(0, true);
  renderModeUI();
  renderHomeQueue();
  renderLibraryQueue();
}

async function playItemsOnce(items, mode) {
  const rows = (items || []).filter((item) => item?.vid);
  if (!rows.length) return false;
  beginLibraryPlaybackSession(rows[0].vid);
  clearSessionQueue();
  setSessionQueue(rows, 0);
  patchState({ activeMode: mode });
  await applyMode(mode);
  showScreen("home");
  await playIndex(0, true);
  renderModeUI();
  renderHomeQueue();
  renderLibraryQueue();
  return true;
}

async function playStandaloneItem(item, mode) {
  await playItemNow(item, mode);
}

async function startFromPlaylistAt(plId, index) {
  const pl = getState().playlists.find((p) => p.id === plId);
  if (!pl?.items?.length) return;
  const item = pl.items[index];
  if (!item?.vid) return;
  setActivePlaylist(plId);
  setCurrentIndex(plId, index);
  beginLibraryPlaybackSession(item.vid);
  clearSessionQueue();
  const mode = getDefaultPlaybackMode();
  patchState({ activeMode: mode });
  await applyMode(mode);
  showScreen("home");
  await playIndex(index, true);
  renderModeUI();
  renderHomeQueue();
  renderLibraryQueue();
}

function addItemToQueue(item) {
  if (!item?.vid) return false;
  const { added, skippedDuplicate } = addItemsToWaitingQueue([item]);
  if (!added) {
    toast(skippedDuplicate ? "이미 다음 재생에 있습니다" : "추가할 수 없습니다");
    return false;
  }
  toast("다음 재생에 추가됨");
  renderHomeQueue();
  renderLibraryQueue();
  return true;
}

async function handleTrackPlayClick(pl, item, index) {
  if (!hasWaitingQueueItems()) {
    await startFromPlaylistAt(pl.id, index);
    return;
  }

  const choice = await showQueueChoiceDialog({
    playlistName: item.title,
    count: 1,
    shuffled: false,
  });
  if (!choice) return;
  if (choice === "replace") clearWaitingQueue();
  addItemToQueue(item);
}

function getUpcomingWaitingRows() {
  const pl = getWaitingQueueAsPlaylist();
  const rows = pl.items.map((item, index) => ({ item, index }));
  if (isQueuePlaybackMode()) {
    return rows.filter(({ index }) => index > pl.cur);
  }
  return rows;
}

function homeQueueSignature(pl) {
  const upcoming = getUpcomingWaitingRows();
  return `${upcoming.length}|${isQueuePlaybackMode() ? pl.cur : ""}|${pl.shuffle ? 1 : 0}|${upcoming.map((i) => i.item.vid).join(",")}`;
}

function setHomeQueueOpen(open) {
  homeQueueOpen = open;
  try {
    localStorage.setItem("homeQueueOpen", String(homeQueueOpen));
  } catch {
    /* ignore */
  }
  updateHomeQueueCollapseUI();
  if (open) renderHomeQueue({ force: true });
}

function syncHomeQueueAfterPlayback() {
  const pl = getWaitingQueueAsPlaylist();
  const sig = homeQueueSignature(pl);
  updateHomeQueueCollapseUI();
  if (!homeQueueOpen) {
    lastHomeQueueSig = sig;
    return;
  }
  if (sig !== lastHomeQueueSig) renderHomeQueue();
}

function updateHomeQueueCollapseUI() {
  const section = $("homeQueue");
  const btn = $("btnToggleHomeQueue");
  const count = $("homeQueueCount");
  const body = $("homeQueueBody");
  const rows = getUpcomingWaitingRows();
  const n = rows.length;
  if (count) count.textContent = n ? `${n}곡` : "";
  if (WATCH_APP_MODE) positionWatchAutoplay();
  $("btnClearHomeQueue")?.classList.toggle("hidden", n === 0);
  section?.classList.toggle("is-collapsed", !homeQueueOpen);
  section?.classList.toggle("has-preview", !homeQueueOpen && n > 0);
  section?.classList.toggle("is-empty", n === 0);
  btn?.setAttribute("aria-expanded", String(homeQueueOpen));
  if (body) {
    body.hidden = !homeQueueOpen;
    if (homeQueueOpen) body.removeAttribute("inert");
    else body.setAttribute("inert", "");
  }
  renderHomeQueuePreview(rows);
}

function renderHomeQueuePreview(rows = getUpcomingWaitingRows()) {
  const preview = $("homeQueuePreview");
  if (!preview) return;
  const visibleRows = homeQueueOpen ? [] : rows.slice(0, 2);
  preview.innerHTML = "";
  preview.hidden = visibleRows.length === 0;

  visibleRows.forEach(({ item, index }) => {
    const button = document.createElement("button");
    button.className = "home-queue-preview-item";
    button.type = "button";
    button.setAttribute("aria-label", `${item.title} 재생`);

    const thumb = document.createElement("span");
    thumb.className = "home-queue-preview-thumb";
    thumb.style.backgroundImage = trackArtBackground(item);

    const meta = document.createElement("span");
    meta.className = "home-queue-preview-meta";
    const title = document.createElement("span");
    title.className = "home-queue-preview-title";
    title.textContent = item.title;
    const artist = document.createElement("span");
    artist.className = "home-queue-preview-artist";
    artist.textContent = item.artist;
    meta.append(title, artist);

    button.append(thumb, meta);
    button.onclick = async () => {
      await startFromWaitingQueue(getDefaultPlaybackMode(), index);
    };
    preview.appendChild(button);
  });
}

function renderHomeQueue({ force = false } = {}) {
  const ul = $("waitingList");
  if (!ul) return;
  const pl = getWaitingQueueAsPlaylist();
  const sig = homeQueueSignature(pl);

  if (!force && !homeQueueOpen) {
    lastHomeQueueSig = sig;
    updateHomeQueueCollapseUI();
    return;
  }
  if (!force && sig === lastHomeQueueSig) {
    updateHomeQueueCollapseUI();
    return;
  }
  lastHomeQueueSig = sig;

  ul.innerHTML = "";
  const rows = getUpcomingWaitingRows();

  if (!rows.length) {
    ul.innerHTML =
      '<li class="home-queue-empty">다음에 재생할 곡이 없습니다.<br>재생목록·검색에서 다음 재생에 추가하세요.</li>';
    updateHomeQueueCollapseUI();
    return;
  }

  const preview = rows.slice(0, 8);
  preview.forEach(({ item, index }) => {
    const li = document.createElement("li");
    li.className = "home-queue-item";
    li.innerHTML = `
      <span class="home-queue-thumb" style="background-image:url(${item.art})"></span>
      <span class="home-queue-meta">
        <div class="home-queue-meta-title">${item.title}</div>
        <div class="home-queue-meta-artist">${item.artist}</div>
      </span>`;
    li.onclick = async () => {
      await startFromWaitingQueue(getDefaultPlaybackMode(), index);
    };
    ul.appendChild(li);
  });
  if (rows.length > preview.length) {
    const more = document.createElement("li");
    more.className = "home-queue-more";
    more.textContent = `외 ${rows.length - preview.length}곡 · 보관함에서 보기`;
    more.onclick = () => {
      libTab = "queue";
      renderLibraryTabUI();
      renderLibraryQueue();
      showScreen("library");
    };
    ul.appendChild(more);
  }
  updateHomeQueueCollapseUI();
}

function renderLibraryQueue() {
  if (queueDragSession?.active) return;
  const ul = $("libraryWaitingList");
  if (!ul) return;
  ul.innerHTML = "";
  const pl = getWaitingQueueAsPlaylist();
  let rows = searchWaitingQueue(waitingSearchQuery);
  if (isQueuePlaybackMode()) {
    rows = rows.filter(({ index }) => index > pl.cur);
  }

  if (!rows.length) {
    ul.innerHTML = '<li class="track-item">대기 목록이 비어 있습니다</li>';
    return;
  }

  rows.forEach(({ item, index }) => {
    const li = document.createElement("li");
    li.className = "track-item";
    li.dataset.qIndex = String(index);
    li.innerHTML = `
      <span class="track-thumb" style="background-image:url(${item.art})"></span>
      <span class="track-info">
        <div class="track-info-title">${item.title}</div>
        <div class="track-info-artist">${item.artist}</div>
      </span>
      <button class="queue-drag-handle" type="button" data-q-drag aria-label="순서 변경" title="드래그해서 순서 변경">
        <span></span><span></span><span></span>
      </button>
      <button class="btn-icon" type="button" data-q-del aria-label="삭제"><svg class="icon icon-sm"><use href="#icon-close"/></svg></button>`;
    bindQueueDragHandle(li, index);
    li.querySelector("[data-q-del]").onclick = (e) => {
      e.stopPropagation();
      removeWaitingQueueItem(index);
      toast("대기 목록에서 삭제");
    };
    li.onclick = async (e) => {
      if (e.target.closest(".btn-icon, [data-q-drag]")) return;
      await startFromWaitingQueue(getDefaultPlaybackMode(), index);
    };
    ul.appendChild(li);
  });
}

function getQueueDropIndexFromDom(list, placeholder, fromIndex) {
  const order = [];
  for (const child of list.children) {
    if (child === placeholder) order.push(fromIndex);
    else if (child.dataset?.qIndex && !child.classList.contains("is-dragging")) {
      order.push(Number(child.dataset.qIndex));
    }
  }
  return order.indexOf(fromIndex);
}

function getQueueDragContainer(itemEl) {
  return itemEl.closest(".screen") || document.body;
}

function viewportPointToContainer(container, top, left) {
  const rect = container.getBoundingClientRect();
  return {
    top: top - rect.top,
    left: left - rect.left,
  };
}

function updateQueueDragPreview(clientX, clientY) {
  const session = queueDragSession;
  if (!session?.active) return;

  const dy = clientY - session.pressY;
  const dx = clientX - session.pressX;
  session.itemEl.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(1.02)`;

  const ghostY = session.originTop + dy + session.originHeight / 2;
  const items = [...session.list.querySelectorAll(".track-item[data-q-index]:not(.is-dragging)")];
  let placed = false;
  for (const item of items) {
    const rect = item.getBoundingClientRect();
    if (ghostY < rect.top + rect.height / 2) {
      session.list.insertBefore(session.placeholder, item);
      placed = true;
      break;
    }
  }
  if (!placed) session.list.appendChild(session.placeholder);
}

function activateQueueDrag(session, clientX, clientY) {
  const { itemEl, list } = session;
  const container = getQueueDragContainer(itemEl);
  const pos = viewportPointToContainer(container, session.originTop, session.originLeft);

  session.placeholder = document.createElement("li");
  session.placeholder.className = "queue-drag-placeholder";
  session.placeholder.setAttribute("aria-hidden", "true");
  session.placeholder.style.height = `${session.originHeight}px`;
  list.insertBefore(session.placeholder, itemEl);

  itemEl.classList.add("is-dragging");
  itemEl.style.position = "fixed";
  itemEl.style.width = `${session.originWidth}px`;
  itemEl.style.height = `${session.originHeight}px`;
  itemEl.style.left = `${pos.left}px`;
  itemEl.style.top = `${pos.top}px`;
  itemEl.style.transform = "translate3d(0, 0, 0) scale(1.02)";
  itemEl.style.zIndex = "20";

  session.active = true;
  list.classList.add("is-reordering");
  updateQueueDragPreview(clientX, clientY);
}

function onQueueDragMove(e) {
  const session = queueDragSession;
  if (!session || session.pointerId !== e.pointerId) return;
  e.preventDefault();

  const moved = Math.hypot(e.clientX - session.startX, e.clientY - session.startY) > 4;
  if (!moved) return;

  if (!session.active) activateQueueDrag(session, e.clientX, e.clientY);
  else updateQueueDragPreview(e.clientX, e.clientY);
}

function endQueueDrag(e) {
  const session = queueDragSession;
  if (!session || session.pointerId !== e.pointerId) return;
  e.preventDefault();
  e.stopPropagation();
  session.handle.releasePointerCapture?.(e.pointerId);
  document.removeEventListener("pointermove", onQueueDragMove);
  document.removeEventListener("pointerup", endQueueDrag);
  document.removeEventListener("pointercancel", endQueueDrag);

  session.list.classList.remove("is-reordering");
  if (session.active) {
    const toIndex = getQueueDropIndexFromDom(session.list, session.placeholder, session.fromIndex);
    const { fromIndex } = session;
    session.placeholder.remove();
    session.itemEl.classList.remove("is-dragging");
    session.itemEl.style.position = "";
    session.itemEl.style.width = "";
    session.itemEl.style.height = "";
    session.itemEl.style.left = "";
    session.itemEl.style.top = "";
    session.itemEl.style.transform = "";
    session.itemEl.style.zIndex = "";
    queueDragSession = null;
    if (toIndex !== fromIndex) reorderWaitingQueueItem(fromIndex, toIndex);
    renderLibraryQueue();
    syncHomeQueueAfterPlayback();
  } else {
    queueDragSession = null;
  }
}

function bindQueueDragHandle(li, fromIndex) {
  const handle = li.querySelector("[data-q-drag]");
  const list = $("libraryWaitingList");
  if (!handle || !list) return;

  handle.onclick = (e) => e.stopPropagation();
  handle.addEventListener("pointerdown", (e) => {
    if (waitingSearchQuery.trim()) {
      toast("검색 중에는 순서를 바꿀 수 없습니다");
      return;
    }
    if (e.button !== undefined && e.button !== 0) return;
    if (queueDragSession) return;
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture?.(e.pointerId);
    const rect = li.getBoundingClientRect();
    queueDragSession = {
      list,
      itemEl: li,
      handle,
      fromIndex,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      pressX: e.clientX,
      pressY: e.clientY,
      originTop: rect.top,
      originLeft: rect.left,
      originWidth: rect.width,
      originHeight: rect.height,
      active: false,
      placeholder: null,
    };
    document.addEventListener("pointermove", onQueueDragMove, { passive: false });
    document.addEventListener("pointerup", endQueueDrag, { passive: false });
    document.addEventListener("pointercancel", endQueueDrag, { passive: false });
  });
}

async function startFromWaitingQueue(mode, index = 0) {
  const pl = getWaitingQueueAsPlaylist();
  if (!pl.items.length) {
    toast("대기 목록이 비어 있습니다");
    return;
  }
  useWaitingQueuePlayback();
  patchState({ activeMode: mode });
  await applyMode(mode);
  showScreen("home");
  await playIndex(index, true);
  renderModeUI();
  renderHomeQueue();
  renderLibraryQueue();
}

function resolveAddTargetId(targetId) {
  return targetId || getState().activePlaylistId;
}

async function addUrlsToTarget(targetId, urls) {
  return addUrlsToPlaylist(resolveAddTargetId(targetId), urls);
}

function urlNeedsImportApi(line) {
  return line.includes("list=") || line.includes("@") || line.includes("/channel/");
}

function getSingleUrlLines() {
  const line = $("singleUrl")?.value?.trim();
  return line ? [line] : [];
}

function canResolveUrlLines(lines) {
  if (!lines.length) {
    toast("URL을 입력하세요");
    return false;
  }
  if (!isSearchConfigured() && lines.some(urlNeedsImportApi)) {
    toast("재생목록·채널 가져오기는 API 설정이 필요합니다");
    return false;
  }
  return true;
}

async function resolveOneTimeUrlItems(lines) {
  if (!canResolveUrlLines(lines)) return null;
  const result = await resolveUrlsToItems(lines);
  if (!result.items.length) {
    toast("유효한 URL이 아닙니다");
    return null;
  }
  return result;
}

async function queueUrlOnce(lines) {
  const result = await resolveOneTimeUrlItems(lines);
  if (!result) return;
  const queueResult = addItemsToWaitingQueue(result.items);
  if (!queueResult.added) {
    toast(queueResult.skippedDuplicate ? "이미 다음 재생에 있습니다" : "추가할 곡이 없습니다");
    return;
  }
  $("singleUrl").value = "";
  toast(
    formatItemsAddedMessage(queueResult.added, {
      ...result,
      skippedDuplicate: queueResult.skippedDuplicate,
    }),
    result.skippedUnavailable ? 4000 : 1800
  );
  renderHomeQueue();
  renderLibraryQueue();
}

async function playUrlOnce(lines) {
  const result = await resolveOneTimeUrlItems(lines);
  if (!result) return;
  const ok = await playItemsOnce(result.items, getDefaultPlaybackMode());
  if (!ok) {
    toast("재생할 곡이 없습니다");
    return;
  }
  $("singleUrl").value = "";
  toast(result.items.length > 1 ? `${result.items.length}곡 재생` : "재생");
}

function isWatchVideoReference(value) {
  const input = String(value || "").trim();
  return /^[A-Za-z0-9_-]{11}$/.test(input) || /(?:youtube\.com|youtu\.be)\//i.test(input);
}

async function submitWatchHomeSearch(value) {
  const query = String(value || "").trim();
  if (!query) {
    toast("검색어를 입력하세요");
    return;
  }

  if (isWatchVideoReference(query)) {
    await playUrlOnce([query]);
    showScreen("home");
    return;
  }

  addTab = "search";
  searchKind = "video";
  renderAddTabUI();
  renderSearchTypeUI();
  showScreen("add", { watchSearch: true });
  if ($("watchSearchResultsKind")) $("watchSearchResultsKind").textContent = "검색 결과";
  resultsMode = "search";
  viewedChannel = null;
  renderChannelSubscribeUI();
  channelVideos = [];
  channelFilter = "all";
  renderChannelFilterUI();
  showChannelFilter(WATCH_APP_MODE);
  if ($("watchSearchResultsTitle")) $("watchSearchResultsTitle").textContent = query;
  const input = $("searchQuery");
  if (input) input.value = query;
  await runSearch();
}

function addItemsToTarget(targetId, items) {
  return addItemsToPlaylist(resolveAddTargetId(targetId), items);
}

function renderTrackList() {
  const pl = getState().playlists.find((p) => p.id === detailPlaylistId);
  const ul = $("trackList");
  ul.innerHTML = "";
  if (!pl) return;
  const rows = searchItems(pl, librarySearchQuery);
  if (!rows.length) {
    ul.innerHTML = '<li class="track-item">검색 결과 없음</li>';
    return;
  }
  rows.forEach(({ item, index }) => {
    const li = document.createElement("li");
    li.className = `track-item track-item-card${index === pl.cur ? " cur" : ""}`;
    li.innerHTML = `
      <div class="track-item-main">
        <span class="track-thumb" style="background-image:url(${item.art})"></span>
        <span class="track-info">
          <div class="track-info-title">${item.title}</div>
          <div class="track-info-artist">${item.artist}</div>
        </span>
      </div>
      <div class="track-action-bar">
        <button class="search-action-btn" type="button" data-track-queue>다음 재생</button>
        <button class="search-action-btn search-action-btn-accent" type="button" data-track-play>재생</button>
        <button class="search-action-btn search-action-btn-icon" type="button" data-track-del aria-label="삭제"><svg class="icon icon-sm"><use href="#icon-close"/></svg></button>
      </div>`;
    li.querySelector("[data-track-queue]").onclick = (e) => {
      e.stopPropagation();
      addItemToQueue(item);
    };
    li.querySelector("[data-track-play]").onclick = (e) => {
      e.stopPropagation();
      void handleTrackPlayClick(pl, item, index);
    };
    li.querySelector("[data-track-del]").onclick = (e) => {
      e.stopPropagation();
      removeItem(pl.id, index);
    };
    ul.appendChild(li);
  });
}

function renderTargetSelect() {
  [$("targetPlaylist"), $("targetPlaylistSearch")].forEach((sel) => {
    if (!sel) return;
    sel.innerHTML = "";
    getState().playlists.forEach((pl) => {
      const opt = document.createElement("option");
      opt.value = pl.id;
      opt.textContent = pl.name;
      if (pl.id === getState().activePlaylistId) opt.selected = true;
      sel.appendChild(opt);
    });
  });
}

function renderAddTabUI() {
  document.querySelectorAll(".add-segment-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.addTab === addTab);
  });
  $("addPanelUrl")?.classList.toggle("hidden", addTab !== "url");
  $("addPanelSearch")?.classList.toggle("hidden", addTab !== "search");
  if (addTab !== "search") disconnectInfiniteScroll("search");
  renderSearchHint();
}

function renderSearchHint() {
  const hint = $("searchHint");
  if (!hint) return;
  if (addTab !== "search" || isSearchConfigured()) {
    hint.classList.add("hidden");
    hint.classList.remove("search-hint-warn");
    return;
  }
  hint.textContent =
    "검색 API 키가 설정되지 않았습니다. Google Cloud에서 YouTube Data API v3 키를 발급한 뒤 YOUTUBE_API_KEY 시크릿을 등록하세요.";
  hint.classList.remove("hidden");
  hint.classList.add("search-hint-warn");
}

const SEARCH_PAGE_SIZE = 25;
// 검색 한 페이지가 유튜브 100유닛이고, 하루 한도는 검색 100번 남짓이다.
// 필터로 걸러져 화면이 안 차면 무한 스크롤이 몇 장씩 연달아 당겨(채널 검색은 한 번에 12장까지)
// 한도를 순식간에 태웠다. 그래서 새 페이지는 자동으로 부르지 않고 '더 보기' 버튼으로만 부른다.
// 이미 받아 둔 결과(searchPendingItems)를 스크롤로 펼치는 건 그대로 자동이다.
const SEARCH_AUTO_PAGES_MAX = 0;
let searchAutoPages = 0;
let searchAutoCapped = false;

function resetSearchPaging() {
  searchNextToken = null;
  searchPendingItems = [];
  shownVideoIds = new Set();
  searchAutoPages = 0;
  searchAutoCapped = false;
}

function uniqueNewItems(items) {
  return (items || []).filter((item) => {
    if (!item?.vid || shownVideoIds.has(item.vid)) return false;
    if (resultsMode === "search" && !matchesVideoKind(item)) return false;
    shownVideoIds.add(item.vid);
    return true;
  });
}

// 쇼츠만 볼 때는 유튜브에 '4분 미만' 만 달라고 한다. 그 뒤 120초 기준으로 다시 거른다.
// 롱폼(120초 초과)은 유튜브가 주는 구간과 맞아떨어지는 게 없어서 전체를 받아 거른다 —
// medium(4~20분)만 받으면 2~4분짜리 뮤직비디오가 통째로 빠진다.
function searchDurationParam() {
  return channelFilter === "short" ? "short" : "";
}

function hasMoreSearchResults() {
  return searchPendingItems.length > 0 || Boolean(searchNextToken);
}

function bindSearchScrollLoad() {
  bindInfiniteScroll("search", {
    sentinel: sentinelInside("searchScrollSentinel", $("searchResults")),
    root: $("searchResults"),
    hasMore: () => addTab === "search" && hasMoreSearchResults(),
    onLoad: loadMoreSearch,
  });
  updateSearchMoreButton();
}

// 롱폼/쇼츠로 걸러 놓으면 한 페이지에서 몇 개 안 남을 수 있다.
// 그러면 스크롤바가 안 생겨 '더 불러오기' 가 영영 안 걸리므로 버튼을 대신 띄운다.
function updateSearchMoreButton() {
  const ul = $("searchResults");
  if (!ul) return;
  let row = ul.querySelector("#searchMoreRow");
  const canScroll = ul.scrollHeight > ul.clientHeight + 8;
  const needed = addTab === "search" && hasMoreSearchResults() && (!canScroll || searchAutoCapped);
  if (!needed) {
    row?.remove();
    return;
  }
  if (row) return;
  row = document.createElement("li");
  row.id = "searchMoreRow";
  row.className = "search-more-row";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "search-action-btn";
  btn.textContent = "더 보기";
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "불러오는 중...";
    try {
      searchAutoPages = 0;
      searchAutoCapped = false;
      await loadMoreSearch({ auto: false });
    } finally {
      row.remove();
      bindSearchScrollLoad();
    }
  };
  row.appendChild(btn);
  ul.appendChild(row);
}

function showNextSearchBatch(items) {
  // 이미 uniqueNewItems 를 지나온 것들이라 여기서 또 거르지 않는다.
  const batch = (items || []).slice(0, SEARCH_PAGE_SIZE);
  if (batch.length) appendVideoSearchResults(batch);
  bindSearchScrollLoad();
  return batch.length;
}

function queueSearchFetch(items, nextPageToken) {
  const fresh = uniqueNewItems(items);
  const first = fresh.slice(0, SEARCH_PAGE_SIZE);
  searchPendingItems = fresh.slice(SEARCH_PAGE_SIZE);
  searchNextToken = nextPageToken || null;
  if (first.length) appendVideoSearchResults(first);
  bindSearchScrollLoad();
  return first.length;
}

function appendVideoSearchResults(items) {
  const ul = $("searchResults");
  if (!ul) return;
  items.forEach((item) => {
    const li = document.createElement("li");
    li.className = "search-result";
    li.innerHTML = `
      <div class="search-result-main">
        <span class="search-thumb" style="background-image:url(${item.art})"></span>
        <span class="search-meta">
          <span class="search-title">${item.title}</span>
          <span class="search-artist">${item.artist}</span>
        </span>
      </div>
      <div class="search-actions${WATCH_APP_MODE ? " watch-search-actions" : ""}">
        ${WATCH_APP_MODE ? "" : '<button class="search-action-btn" type="button" data-search-play="music">음악</button>'}
        <button class="search-action-btn" type="button" data-search-play="video">${WATCH_APP_MODE ? "재생" : "영상"}</button>
        <button class="search-action-btn search-action-btn-accent" type="button" data-search-queue>다음 재생</button>
        <button class="search-action-btn search-action-btn-icon" type="button" data-search-add aria-label="재생목록에 추가"><svg class="icon icon-sm"><use href="#icon-add"/></svg></button>
      </div>`;
    const musicButton = li.querySelector('[data-search-play="music"]');
    if (musicButton) musicButton.onclick = () => playSearchItem(item, "music");
    li.querySelector('[data-search-play="video"]').onclick = () => playSearchItem(item, "video");
    li.querySelector("[data-search-queue]").onclick = () => addItemToQueue(item);
    li.querySelector("[data-search-add]").onclick = () => addSearchItem(item);
    ul.appendChild(li);
  });
}

function renderSearchResults(items) {
  const ul = $("searchResults");
  if (!ul) return;
  ul.innerHTML = "";
  if (!items.length) {
    ul.innerHTML =
      channelFilter === "short"
        ? '<li class="search-empty">이 검색어에는 쇼츠가 없습니다.</li>'
        : channelFilter === "long"
          ? '<li class="search-empty">이 검색어에는 롱폼이 없습니다.</li>'
          : '<li class="search-empty">검색 결과가 없습니다.</li>';
    bindSearchScrollLoad();
    return;
  }
  appendVideoSearchResults(items);
  bindSearchScrollLoad();
}

function appendChannelSearchResults(channels) {
  const ul = $("searchResults");
  if (!ul) return;
  channels.forEach((ch) => {
    const li = document.createElement("li");
    li.className = "search-result";
    const art = ch.art || "";
    li.innerHTML = `
      <div class="search-result-main">
        <span class="search-thumb search-thumb-round" style="background-image:url(${art})"></span>
        <span class="search-meta">
          <span class="search-title">${ch.title}</span>
          <span class="search-artist">YouTube 채널</span>
        </span>
      </div>
      <div class="search-actions search-actions-channel">
        <button class="search-action-btn" type="button" data-channel-load>영상 보기</button>
        <button class="search-action-btn search-action-btn-icon" type="button" data-channel-add aria-label="재생목록에 추가"><svg class="icon icon-sm"><use href="#icon-add"/></svg></button>
      </div>`;
    li.querySelector("[data-channel-load]").onclick = () => loadChannelVideos(ch);
    li.querySelector("[data-channel-add]").onclick = () => addChannelToPlaylist(ch);
    ul.appendChild(li);
  });
}

function renderChannelResults(channels) {
  const ul = $("searchResults");
  if (!ul) return;
  ul.innerHTML = "";
  if (!channels.length) {
    ul.innerHTML = '<li class="search-empty">채널을 찾지 못했습니다.</li>';
    bindSearchScrollLoad();
    return;
  }
  appendChannelSearchResults(channels);
  bindSearchScrollLoad();
}

async function addChannelToPlaylist(ch) {
  const plId = getSearchTargetPlaylistId();
  if (!plId) {
    toast("추가할 대상을 선택하세요");
    return;
  }
  $("searchResults").innerHTML = '<li class="search-empty">채널 영상 불러오는 중...</li>';
  const { items, channelTitle, error, truncated, skipped, duplicates } = await fetchChannelVideos(
    { channelId: ch.channelId },
    500
  );
  if (error || !items.length) {
    toast("채널 영상을 불러오지 못했습니다");
    renderChannelResults([ch]);
    return;
  }
  const result = addItemsToTarget(plId, items);
  toast(
    formatItemsAddedMessage(result.added, {
      ...result,
      skippedUnavailable: skipped || 0,
      importDuplicates: duplicates || 0,
      truncated,
    })
  );
  renderChannelResults([ch]);
}

function isShortVideo(item) {
  const sec = Number(item?.sec) || 0;
  return sec > 0 && sec <= SHORTS_MAX_SEC;
}

function matchesVideoKind(item) {
  if (channelFilter === "short") return isShortVideo(item);
  if (channelFilter === "long") return !isShortVideo(item);
  return true;
}

function filteredChannelVideos() {
  return channelVideos.filter(matchesVideoKind);
}

function renderChannelFilterUI() {
  document.querySelectorAll(".watch-channel-filter-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.channelFilter === channelFilter);
  });
}

function renderChannelVideoList() {
  const items = filteredChannelVideos();
  renderChannelFilterUI();
  renderSearchResults(items);
  const ul = $("searchResults");
  if (ul && !items.length) {
    ul.innerHTML =
      channelFilter === "short"
        ? '<li class="search-empty">쇼츠가 없습니다.</li>'
        : '<li class="search-empty">영상이 없습니다.</li>';
  }
}

function showChannelFilter(show) {
  $("watchChannelFilter")?.classList.toggle("hidden", !show);
}

async function loadChannelVideos(ch) {
  if (searchBusy) return;
  searchBusy = true;
  resetSearchPaging();
  disconnectInfiniteScroll("search");
  $("searchResults").innerHTML = '<li class="search-empty">최신 영상 불러오는 중...</li>';
  try {
    const { items, channelTitle, error, truncated } = await fetchChannelVideos({ channelId: ch.channelId }, 200);
    if (error || !items.length) {
      toast("영상을 불러오지 못했습니다");
      renderChannelResults([ch]);
      return;
    }
    searchKind = "video";
    renderSearchTypeUI();
    channelVideos = items;
    channelFilter = "all";
    resultsMode = "channel";
    viewedChannel = {
      channelId: ch.channelId,
      title: ch.title || channelTitle || "채널",
      art: ch.art || "",
    };
    renderChannelSubscribeUI();
    showChannelFilter(WATCH_APP_MODE);
    renderChannelVideoList();
    toast(
      truncated
        ? `${channelTitle || ch.title} ${items.length}개 (최대 500곡)`
        : `${channelTitle || ch.title} ${items.length}개`
    );
  } finally {
    searchBusy = false;
  }
}

function renderSearchTypeUI() {
  document.querySelectorAll(".search-type-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.searchKind === searchKind);
  });
  $("searchQuery").placeholder =
    searchKind === "channel" ? "채널 이름, @핸들" : "곡 제목, 아티스트, 키워드";
  renderSearchHint();
}

function getSearchTargetPlaylistId() {
  return $("targetPlaylistSearch")?.value || getState().activePlaylistId;
}

async function addSearchItem(item) {
  const plId = getSearchTargetPlaylistId();
  if (!plId) {
    toast("추가할 재생목록을 선택하세요");
    return;
  }
  const pl = getState().playlists.find((p) => p.id === plId);
  if (findItemIndex(pl, item.vid) >= 0) {
    toast("이미 목록에 있습니다");
    return;
  }
  const { added } = addItemsToPlaylist(plId, [item]);
  if (added) toast("재생목록에 추가됨");
}

async function playSearchItem(item, mode) {
  const playbackMode = WATCH_APP_MODE ? "video" : mode;
  await playStandaloneItem(item, playbackMode);
  toast(playbackMode === "music" ? "음악으로 재생" : "영상으로 재생");
}

async function runSearch() {
  if (searchBusy) return;
  const q = $("searchQuery")?.value?.trim();
  if (!q) {
    toast("검색어를 입력하세요");
    return;
  }
  if (!isSearchConfigured()) {
    // 부팅 때 /api/config를 못 읽었을 수 있으므로 한 번 더 시도한다.
    await loadSearchConfig();
    renderSearchHint();
  }
  if (!isSearchConfigured()) {
    toast("검색 API 키 설정 필요");
    return;
  }
  searchBusy = true;
  resetSearchPaging();
  disconnectInfiniteScroll("search");
  lastSearchQuery = q;
  $("btnSearch").disabled = true;
  $("searchResults").innerHTML = '<li class="search-empty">검색 중...</li>';
  try {
    if (searchKind === "channel") {
      const { channels, nextPageToken, error } = await searchChannels(q, { limit: 50 });
      if (error === "search_not_configured") {
        toast("검색 API 키 설정 필요");
        renderSearchHint();
        renderChannelResults([]);
        return;
      }
      if (error) {
        $("searchResults").firstElementChild.textContent = searchErrorMessage(error, "채널 검색에 실패했습니다.");
        return;
      }
      searchNextToken = nextPageToken;
      renderChannelResults(channels);
      if (!channels.length) toast("결과 없음");
      return;
    }

    const { items, nextPageToken, error } = await searchYouTube(q, {
      limit: 50,
      duration: searchDurationParam(),
    });
    if (error === "search_not_configured") {
      toast("검색 API 키 설정 필요");
      renderSearchHint();
      renderSearchResults([]);
      return;
    }
    if (error) {
      $("searchResults").firstElementChild.textContent = searchErrorMessage(error);
      return;
    }
    $("searchResults").innerHTML = "";
    const shown = queueSearchFetch(items, nextPageToken);
    if (!shown) renderSearchResults([]);
    if (!items.length) toast("결과 없음");
  } finally {
    searchBusy = false;
    $("btnSearch").disabled = false;
  }
}

async function loadMoreSearch({ auto = true } = {}) {
  if (searchBusy || !lastSearchQuery) return;
  if (!hasMoreSearchResults()) return;

  searchBusy = true;
  try {
    if (searchKind === "channel") {
      if (!searchNextToken) return;
      if (auto && searchAutoPages >= SEARCH_AUTO_PAGES_MAX) {
        searchAutoCapped = true;
        disconnectInfiniteScroll("search");
        updateSearchMoreButton();
        return;
      }
      searchAutoPages += 1;
      const { channels, nextPageToken, error } = await searchChannels(lastSearchQuery, {
        limit: 50,
        pageToken: searchNextToken,
      });
      if (error) {
        toast(searchErrorMessage(error, "더 불러오기에 실패했습니다."));
        return;
      }
      searchNextToken = nextPageToken;
      appendChannelSearchResults(channels);
      if (!channels.length) toast("더 이상 결과 없음");
      return;
    }

    if (searchPendingItems.length > 0) {
      const batch = searchPendingItems.splice(0, SEARCH_PAGE_SIZE);
      const n = showNextSearchBatch(batch);
      if (!n) toast("더 이상 결과 없음");
      return;
    }

    if (!searchNextToken) return;

    if (auto && searchAutoPages >= SEARCH_AUTO_PAGES_MAX) {
      // 여기서부터는 사용자가 직접 부를 때만 가져온다.
      searchAutoCapped = true;
      disconnectInfiniteScroll("search");
      updateSearchMoreButton();
      return;
    }
    searchAutoPages += 1;

    const { items, nextPageToken, error } = await searchYouTube(lastSearchQuery, {
      limit: 50,
      pageToken: searchNextToken,
      duration: searchDurationParam(),
    });
    if (error) {
      toast(searchErrorMessage(error, "더 불러오기에 실패했습니다."));
      return;
    }
    const n = queueSearchFetch(items, nextPageToken);
    if (!n) toast("더 이상 결과 없음");
  } finally {
    searchBusy = false;
    bindSearchScrollLoad();
  }
}

function renderAuthUI() {
  const user = getUser();
  const configured = isConfigured();

  $("btnGoogleLogin")?.classList.toggle("hidden", Boolean(user));
  $("btnLogout")?.classList.toggle("hidden", !user);
  $("btnHeaderGoogle")?.classList.toggle("hidden", Boolean(user));
  $("btnHeaderUser")?.classList.toggle("hidden", !user);

  if (user) {
    const label = user.displayName || user.email || "로그인됨";
    $("authStatus").textContent = user.email || label;
    $("headerUserLabel").textContent = label;
    const avatar = $("headerAvatar");
    if (user.photoURL) {
      avatar.src = user.photoURL;
      avatar.classList.remove("hidden");
    } else {
      avatar.classList.add("hidden");
    }
  } else {
    $("authStatus").textContent = configured ? "로그인 안 됨" : "Google OAuth 미설정";
    $("headerUserLabel").textContent = "";
  }

  $("defaultMode").value = getState().defaultMode || "music";
  if ($("uiTheme")) $("uiTheme").value = normalizeUiTheme(getState().uiTheme);
  if ($("defaultRepeat")) $("defaultRepeat").value = getState().defaultRepeat || "all";
  applyUiTheme(WATCH_APP_MODE ? "default" : undefined);
  renderVideoQualityUI();

  const access = getAccessState();
  const accessEl = $("accessStatus");
  if (accessEl) {
    if (access.publicAccess) {
      accessEl.textContent = "로그인 없이 이용 가능";
    } else if (!user) {
      accessEl.textContent = "로그인 필요";
    } else if (access.admin) {
      accessEl.textContent = "관리자 (무제한)";
    } else if (access.active) {
      accessEl.textContent = access.unlimited
        ? "이용 중 · 무한"
        : `이용 중 · ${formatRemaining(access.remainingMs)} 남음`;
    } else {
      accessEl.textContent = "이용 코드 필요";
    }
  }
  $("linkAdmin")?.classList.toggle("hidden", !access.admin);
  setWithdrawVisible(Boolean(user));

  const syncEl = $("syncStatus");
  if (syncEl) syncEl.textContent = getSyncLabel();

  const loginBtns = [$("btnGoogleLogin"), $("btnHeaderGoogle")];
  loginBtns.forEach((btn) => {
    if (!btn) return;
    btn.disabled = !configured;
    const label = btn.querySelector("span");
    if (label) label.textContent = configured ? "Google로 로그인" : "OAuth 설정 필요";
  });
}

function renderVideoQualityUI() {
  const pref = getState().videoQuality || "auto";
  const active = pref === "auto" ? "auto" : "highres";
  if (pref !== active) patchState({ videoQuality: active });
  document.querySelectorAll(".quality-segment-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.quality === active);
  });
}

function renderSettings() {
  renderAuthUI();
}

function readJsonStorage(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}

function buildFeedbackPayload() {
  const item = getNowPlayingItem();
  const report = {
    type: $("feedbackType")?.value || "feedback",
    message: $("feedbackMessage")?.value.trim() || "",
    logs: [],
  };
  if (!$("feedbackIncludeLogs")?.checked) return report;
  return {
    ...report,
    userAgent: navigator.userAgent,
    standalone: isStandalonePwa(),
    screen: document.querySelector(".screen-active")?.dataset.screen ?? null,
    mode: getState().activeMode,
    uiTheme: getState().uiTheme || "default",
    playing,
    playback: {
      playing,
      activeMode: getState().activeMode,
      defaultMode: getState().defaultMode,
      currentTime: lastProgressCur,
      duration: lastProgressDur,
      nowPlaying: item
        ? {
            vid: item.vid,
            title: item.title,
            artist: item.artist,
          }
        : null,
    },
    viewport: readJsonStorage("viewport-debug"),
    logs: readBgDebugLog().slice(-160),
  };
}

async function sendFeedback() {
  const btn = $("btnSendFeedback");
  const input = $("feedbackMessage");
  const payload = buildFeedbackPayload();
  if (!payload.message) {
    toast("내용을 입력해 주세요");
    input?.focus();
    return;
  }

  btn.disabled = true;
  try {
    const res = await fetch("api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error("send_failed");
    debugBg("feedback", "app.js:sendFeedback", "feedback-sent", {
      type: payload.type,
      includeLogs: payload.logs.length > 0,
    });
    input.value = "";
    toast("보냈습니다");
  } catch {
    toast("전송에 실패했습니다");
  } finally {
    btn.disabled = false;
  }
}

async function handleGoogleLogin() {
  try {
    await signInWithGoogle();
  } catch (e) {
    toast(e.message || "로그인 실패");
  }
}

function bindEvents() {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.onclick = () => {
      if (WATCH_APP_MODE) setWatchRail(false);
      showScreen(btn.dataset.nav);
    };
  });
  $("watchDrawerBackdrop")?.addEventListener("click", () => showScreen("home"));
  $("watchRailToggle")?.addEventListener("click", () => {
    setWatchRail(!document.documentElement.classList.contains("watch-rail-open"));
  });
  document.querySelectorAll(".watch-channel-filter-btn").forEach((btn) => {
    btn.onclick = async () => {
      if (channelFilter === btn.dataset.channelFilter) return;
      channelFilter = btn.dataset.channelFilter;
      renderChannelFilterUI();
      if (resultsMode === "channel") {
        renderChannelVideoList();
      } else {
        await runSearch();
      }
      $("searchResults")?.scrollTo({ top: 0 });
    };
  });
  $("watchHomeChannelBtn")?.addEventListener("click", () => {
    void openWatchChannelView();
  });
  if (WATCH_APP_MODE) {
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") setWatchRail(false);
    });
  }
  $("watchSearchResultsClose")?.addEventListener("click", () => showScreen("home"));
  $("watchHomeCopyLink")?.addEventListener("click", async () => {
    const item = getNowPlayingItem();
    if (!item?.vid) return;
    const url = new URL("watch", document.baseURI);
    url.searchParams.set("v", item.vid);
    try {
      await navigator.clipboard.writeText(url.toString());
      toast("시청 링크를 복사했습니다");
    } catch {
      toast("링크를 복사하지 못했습니다");
    }
  });

  document.querySelectorAll(".mode-segment-btn").forEach((btn) => {
    btn.onclick = async () => {
      await setPlaybackMode(btn.dataset.mode);
    };
  });

  $("btnOpenWatch").onclick = () => {
    const item = getNowPlayingItem();
    if (!item?.vid) {
      toast("먼저 시청할 영상을 선택해 주세요.");
      return;
    }
    const { cur } = getPlaybackProgress();
    const url = new URL("watch", document.baseURI);
    url.searchParams.set("v", item.vid);
    if (cur > 1) url.searchParams.set("t", String(Math.floor(cur)));
    location.href = url;
  };

  bindPlayControl($("btnPlay"));
  bindPlayControl($("miniPlayBtn"));
  $("btnNext").onclick = () => playNext(true);
  $("btnPrev").onclick = () => playPrev(true);
  $("btnShuffle").onclick = () => {
    if (hasWaitingQueueItems()) {
      toggleShuffle();
      renderNowPlaying();
      renderHomeQueue({ force: true });
      renderLibraryQueue();
      return;
    }
    toggleShuffle();
    renderNowPlaying();
  };
  $("btnRepeat").onclick = () => {
    cycleRepeat();
    renderNowPlaying();
  };
  $("miniPlayerOpen").onclick = () => showScreen("home");

  bindProgressBar();

  $("btnToggleHomeQueue")?.addEventListener("click", (e) => {
    e.preventDefault();
    setHomeQueueOpen(!homeQueueOpen);
  });
  bindQueueChoiceDialog();

  $("btnNewPlaylist").onclick = () => {
    const name = prompt("새 재생목록 이름", "새 재생목록");
    if (name) createPlaylist(name);
  };
  document.querySelectorAll(".library-segment-btn").forEach((btn) => {
    btn.onclick = () => {
      libTab = btn.dataset.libTab || "playlists";
      if (libTab === "history") resetHistoryPaging();
      renderLibraryTabUI();
      if (libTab === "history") renderHistoryList();
      if (libTab === "queue") renderLibraryQueue();
    };
  });
  // 홈의 `다음 재생` 머리줄에서도 바로 비울 수 있게 한다.
  const clearWaitingList = () => {
    const pl = getWaitingQueueAsPlaylist();
    if (!pl.items.length) {
      toast("대기 목록이 비어 있습니다");
      return;
    }
    if (!confirm("다음 재생 목록을 모두 비울까요?")) return;
    clearWaitingQueue();
    toast("다음 재생 목록을 비웠습니다");
    renderHomeQueue();
    renderLibraryQueue();
    renderNowPlaying();
  };
  $("btnClearHomeQueue")?.addEventListener("click", (e) => {
    e.stopPropagation();
    clearWaitingList();
  });
  $("btnClearWaiting")?.addEventListener("click", () => {
    const pl = getWaitingQueueAsPlaylist();
    if (!pl.items.length) {
      toast("대기 목록이 비어 있습니다");
      return;
    }
    if (confirm("다음 재생 목록을 모두 비울까요?")) {
      clearWaitingQueue();
      toast("다음 재생 목록을 비웠습니다");
      renderHomeQueue();
      renderLibraryQueue();
      renderNowPlaying();
    }
  });
  $("waitingSearch")?.addEventListener("input", (e) => {
    waitingSearchQuery = e.target.value;
    renderLibraryQueue();
  });

  $("btnClearHistory").onclick = () => {
    if (!getState().watchHistory?.length) {
      toast("기록 없음");
      return;
    }
    if (confirm("시청 기록을 모두 삭제할까요?")) {
      clearWatchHistory();
      resetHistoryPaging();
      toast("시청 기록 삭제됨");
    }
  };
  $("historySearch").oninput = (e) => {
    historySearchQuery = e.target.value;
    resetHistoryPaging();
    renderHistoryList();
  };
  $("btnBackLibrary").onclick = () => closePlaylistDetail();
  $("librarySearch").oninput = (e) => {
    librarySearchQuery = e.target.value;
    renderTrackList();
  };
  $("btnAddAllToQueue").onclick = () => {
    void addAllPlaylistToQueue(false);
  };
  $("btnAddAllToQueueShuffle").onclick = () => {
    void addAllPlaylistToQueue(true);
  };

  $("btnAddSingle").onclick = async () => {
    const id = $("targetPlaylist").value || getState().activePlaylistId;
    const line = $("singleUrl").value.trim();
    if (!line) {
      toast("URL을 입력하세요");
      return;
    }
    if (!isSearchConfigured() && (line.includes("list=") || line.includes("@") || line.includes("/channel/"))) {
      toast("재생목록·채널 가져오기는 API 키 필요");
      return;
    }
    const result = await addUrlsToTarget(id, [line]);
    if (result.added) {
      $("singleUrl").value = "";
      toast(formatItemsAddedMessage(result.added, result), result.skippedUnavailable ? 4000 : 1800);
    } else toast("유효한 URL이 아닙니다");
  };
  $("btnUrlQueue")?.addEventListener("click", () => {
    void queueUrlOnce(getSingleUrlLines());
  });
  $("btnUrlPlay")?.addEventListener("click", () => {
    void playUrlOnce(getSingleUrlLines());
  });
  $("singleUrl")?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    void playUrlOnce(getSingleUrlLines());
  });
  $("btnAddBulk").onclick = async () => {
    const id = $("targetPlaylist").value || getState().activePlaylistId;
    const lines = $("bulkUrls").value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const result = await addUrlsToTarget(id, lines);
    $("bulkUrls").value = "";
    toast(result.added ? formatItemsAddedMessage(result.added, result) : "추가된 URL 없음", result.skippedUnavailable ? 4000 : 1800);
  };

  document.querySelectorAll(".add-segment-btn").forEach((btn) => {
    btn.onclick = () => {
      addTab = btn.dataset.addTab || "url";
      renderAddTabUI();
    };
  });

  document.querySelectorAll(".search-type-btn").forEach((btn) => {
    btn.onclick = () => {
      searchKind = btn.dataset.searchKind || "video";
      resetSearchPaging();
      lastSearchQuery = "";
      renderSearchTypeUI();
      $("searchResults").innerHTML = "";
      disconnectInfiniteScroll("search");
    };
  });

  $("btnSearch").onclick = () => runSearch();
  $("searchQuery")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
  });
  $("watchHomeSearch")?.addEventListener("submit", (e) => {
    e.preventDefault();
    void submitWatchHomeSearch($("watchHomeQuery")?.value);
  });

  $("btnGoogleLogin").onclick = () => handleGoogleLogin();
  $("btnHeaderGoogle").onclick = () => handleGoogleLogin();
  $("btnHeaderUser").onclick = () => showScreen("settings");
  $("btnLogout").onclick = () => handleLogout();

  $("defaultMode").onchange = async (e) => {
    await setPlaybackMode(e.target.value, { asDefault: true });
    renderSettings();
  };
  $("uiTheme")?.addEventListener("change", (e) => {
    const uiTheme = normalizeUiTheme(e.target.value);
    setUiThemePreference(uiTheme);
    applyUiTheme(uiTheme);
    renderSettings();
  });
  $("defaultRepeat")?.addEventListener("change", (e) => {
    const value = e.target.value;
    const wq = getState().waitingQueue;
    patchState({
      defaultRepeat: value,
      waitingQueue: wq ? { ...wq, repeat: value } : wq,
    });
    renderNowPlaying();
  });
  $("btnSendFeedback")?.addEventListener("click", sendFeedback);
  document.querySelectorAll(".quality-segment-btn").forEach((btn) => {
    btn.onclick = () => {
      setVideoQuality(btn.dataset.quality);
      renderVideoQualityUI();
      renderModeUI();
    };
  });

}

function shuffleArray(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function addAllPlaylistToQueue(shuffled = false) {
  if (!detailPlaylistId) return;
  const pl = getState().playlists.find((p) => p.id === detailPlaylistId);
  if (!pl?.items?.length) {
    toast("담을 곡이 없습니다");
    return;
  }
  let queueMode = "append";
  if (hasWaitingQueueItems()) {
    const choice = await showQueueChoiceDialog({
      playlistName: pl.name,
      count: pl.items.length,
      shuffled,
    });
    if (!choice) return;
    queueMode = choice;
    void (
      "다음 재생 목록이 이미 있습니다.\n\n확인: 기존 목록 삭제 후 새로 담기\n취소: 기존 목록에 추가로 담기"
    );
  }
  if (queueMode === "replace") clearWaitingQueue();
  const items = shuffled ? shuffleArray(pl.items) : pl.items;
  const { added, skippedDuplicate } = addItemsToWaitingQueue(items);
  if (!added) {
    toast(skippedDuplicate ? "이미 모두 다음 재생에 있습니다" : "담을 곡이 없습니다");
    return;
  }
  const msg = formatItemsAddedMessage(added, { skippedDuplicate });
  toast(shuffled ? `셔플하여 ${msg}` : msg, skippedDuplicate ? 3000 : 1800);
  renderHomeQueue();
  renderLibraryQueue();
}

function renderAll() {
  renderModeUI();
  renderNowPlaying();
  renderPlaylistCards();
  renderTrackList();
  renderHomeQueue();
  renderLibraryQueue();
  renderHistoryList();
  renderTargetSelect();
  renderLibraryTabUI();
  renderAddTabUI();
  renderSearchTypeUI();
  renderSettings();
}

let appServicesStarted = false;
let gateReady = false;

function updateGate() {
  const user = getUser();
  const access = getAccessState();
  const overlay = $("gateOverlay");
  const app = $("app");
  if (!overlay) return canUseApp();

  if (!gateReady) {
    overlay.classList.add("hidden");
    app?.classList.add("app-booting");
    return false;
  }

  app?.classList.remove("app-booting");

  if (access.publicAccess) {
    const wasLocked = app?.classList.contains("app-locked");
    overlay.classList.add("hidden");
    app?.classList.remove("app-locked");
    if (wasLocked) showScreen("home");
    return true;
  }

  if (!user) {
    overlay.classList.remove("hidden");
    app?.classList.add("app-locked");
    $("gateTitle").textContent = "로그인이 필요합니다";
    $("gateDesc").textContent = "Google 계정으로 로그인해야 이용할 수 있습니다.";
    $("gateLoginBtn")?.classList.remove("hidden");
    $("gateCodePanel")?.classList.add("hidden");
    $("gateAccountActions")?.classList.add("hidden");
    return false;
  }

  if (!access.active) {
    overlay.classList.remove("hidden");
    app?.classList.add("app-locked");
    $("gateTitle").textContent = "이용 코드 입력";
    $("gateDesc").textContent = "관리자에게 받은 코드를 입력해 주세요. 코드는 계정당 1회만 사용할 수 있습니다.";
    $("gateLoginBtn")?.classList.add("hidden");
    $("gateCodePanel")?.classList.remove("hidden");
    $("gateAccountActions")?.classList.remove("hidden");
    return false;
  }

  const wasLocked = app?.classList.contains("app-locked");
  overlay.classList.add("hidden");
  app?.classList.remove("app-locked");
  if (wasLocked) showScreen("home");
  return true;
}

async function handleLogout() {
  try {
    await signOutUser();
  } catch (error) {
    toast(error.message || "로그아웃 요청에 실패했습니다.");
    return;
  }
  await syncOnLogout();
  ensureDefaultPlaylist();
  renderAll();
  updateGate();
  toast("로그아웃");
}

function bindGateEvents() {
  $("gateLoginBtn")?.addEventListener("click", () => {
    if (isConfigured()) signInWithGoogle();
    else toast("Google OAuth가 설정되지 않았습니다.");
  });

  const submitCode = async () => {
    const input = $("gateCodeInput");
    const err = $("gateCodeError");
    if (!input?.value.trim()) return;
    err?.classList.add("hidden");
    try {
      await redeemCode(input.value);
      input.value = "";
      toast("이용 코드가 등록되었습니다.");
      updateGate();
      if (canUseApp()) await startAppServices();
    } catch (e) {
      if (err) {
        err.textContent = e.message || "코드 등록 실패";
        err.classList.remove("hidden");
      }
    }
  };

  $("gateCodeBtn")?.addEventListener("click", submitCode);
  $("gateCodeInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitCode();
  });
  $("gateLogoutBtn")?.addEventListener("click", () => handleLogout());
}

function isStandalonePwa() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

function isKeyboardLikelyOpen(vv) {
  if (!vv) return false;
  return vv.height < window.innerHeight * 0.82;
}

// #region agent log
function getPhysicalViewportBottom() {
  const vv = window.visualViewport;
  const fromVv = vv ? vv.height + vv.offsetTop : 0;
  return Math.max(window.innerHeight, document.documentElement.clientHeight, fromVv);
}

function measureNavBottomGap(nav) {
  if (!nav) return 0;
  return Math.max(0, Math.round(getPhysicalViewportBottom() - nav.getBoundingClientRect().bottom));
}

function measureBottomLayout() {
  const app = document.querySelector(".app");
  const mini = document.getElementById("miniPlayer");
  const nav = document.querySelector(".bottom-nav");
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      height: Math.round(r.height),
    };
  };
  const appR = rect(app);
  const miniR = rect(mini);
  const navR = rect(nav);
  const miniNavGap = miniR && navR ? Math.round(navR.top - miniR.bottom) : null;
  const navBottomGap = navR ? measureNavBottomGap(document.querySelector(".bottom-nav")) : null;
  const appBottomGap = appR ? Math.max(0, Math.round(getPhysicalViewportBottom() - appR.bottom)) : null;
  return {
    app: appR,
    mini: miniR,
    nav: navR,
    miniNavGap,
    navBottomGap,
    appBottomGap,
    physicalViewportBottom: Math.round(getPhysicalViewportBottom()),
    screenBottomGap: Math.max(0, Math.round(window.screen.height - window.innerHeight)),
    cssVersion: document.querySelector('link[href*="styles.css"]')?.getAttribute("href") || "",
    layoutMode: "standalone-only-fixed-chrome",
    activeScreen: document.querySelector(".screen-active")?.dataset.screen ?? null,
    miniVisible: mini?.classList.contains("is-visible") ?? false,
  };
}

function logViewportLayout(data, hypothesisId = "viewport") {
  debugBg(hypothesisId, "app.js:logViewportLayout", "viewport layout sync", {
    runId: "post-fix-standalone-only",
    ...data,
  });
}

function renderViewportDebugOverlay(payload) {
  const params = new URLSearchParams(location.search);
  if (!params.has("debugLayout")) return;
  let el = document.getElementById("viewportDebug");
  if (!el) {
    el = document.createElement("pre");
    el.id = "viewportDebug";
    el.className = "viewport-debug";
    document.body.appendChild(el);
  }
  const bgLogs = readBgDebugLog().slice(-25);
  el.textContent = JSON.stringify({ layout: payload, bgPlayback: bgLogs }, null, 2);
}

function renderBgDebugPanel() {
  if (!new URLSearchParams(location.search).has("debug")) return;
  renderViewportDebugOverlay(measureBottomLayout());
}
// #endregion

function syncViewportLayout() {
  cancelAnimationFrame(syncViewportLayout._raf);
  syncViewportLayout._raf = requestAnimationFrame(() => {
    const vv = window.visualViewport;
    const standalone = isStandalonePwa();
    const keyboardOpen = vv ? isKeyboardLikelyOpen(vv) : false;
    document.documentElement.classList.toggle("pwa-standalone", standalone);

    // #region agent log
    const layout = measureBottomLayout();
    const metrics = {
      standalone,
      displayMode: window.matchMedia("(display-mode: standalone)").matches,
      navigatorStandalone: window.navigator.standalone === true,
      keyboardOpen,
      innerHeight: window.innerHeight,
      clientHeight: document.documentElement.clientHeight,
      bodyHeight: Math.round(document.body.getBoundingClientRect().height),
      appHeight: Math.round(document.querySelector(".app")?.getBoundingClientRect().height ?? 0),
      screenHeight: window.screen.height,
      physicalViewportBottom: Math.round(getPhysicalViewportBottom()),
      vvHeight: vv?.height ?? null,
      vvOffsetTop: vv?.offsetTop ?? null,
      safeBottom: getComputedStyle(document.documentElement).getPropertyValue("--safe-bottom").trim(),
      screenBottomGap: Math.max(0, Math.round(window.screen.height - window.innerHeight)),
      layout: { ...layout, layoutMode: "standalone-100vh-fix74" },
    };
    logViewportLayout(metrics, "H-body-fixed");
    try {
      localStorage.setItem("viewport-debug", JSON.stringify({ ...metrics, ts: Date.now() }));
    } catch {}
    renderViewportDebugOverlay(metrics);
    // #endregion
  });
}

function bindViewportLayout() {
  syncViewportLayout();
  window.visualViewport?.addEventListener("resize", syncViewportLayout);
  window.visualViewport?.addEventListener("scroll", syncViewportLayout);
  window.addEventListener("resize", syncViewportLayout);
  window.addEventListener("orientationchange", () => {
    setTimeout(syncViewportLayout, 120);
  });
}

function applyStartupSession() {
  const mode = WATCH_APP_MODE ? "video" : getDefaultPlaybackMode();
  if (WATCH_APP_MODE) homeQueueOpen = true;
  patchState({ activeMode: mode });
  leaveQueuePlaybackMode();
  restoreLastPlayedSession();
  renderModeUI();
  initPlayerShell();
}

// 다시 들어왔을 때 `지금 재생` 에 뜨는 곡을 실제 재생 대상으로도 맞춰 둔다.
// 이걸 안 하면 화면은 마지막 곡을 보여 주는데 재생은 보관함 목록을 물고 있어서,
// 그 곡이 끝나면 다음 재생이 비어 있어도 보관함 다음 곡으로 넘어가 버린다.
function restoreLastPlayedSession() {
  const st = getState();
  const last = st.lastPlayed;
  if (!last?.vid) return;
  if (st.sessionQueue?.items?.length || hasWaitingQueueItems()) return;
  setSessionQueue([last], 0);
  const sq = getState().sessionQueue;
  // 혼자 다음 곡으로 넘어가거나 되감지 않게 한다.
  if (sq) patchState({ sessionQueue: { ...sq, repeat: "off" } });
}

async function startAppServices() {
  if (appServicesStarted) return;
  appServicesStarted = true;
  await loadSearchConfig();
  renderSearchHint();
  if (getUser()) await syncOnLogin();
  applyStartupSession();
  await warmPlayer();
  setVolume(getState().volume ?? 100, { userInitiated: false });
  setInterval(() => refreshAccess(), 60000);
}

async function boot() {
  bindViewportLayout();
  ensureDefaultPlaylist();
  ensureWaitingQueue();
  applyUiTheme(WATCH_APP_MODE ? "default" : undefined);
  // 미디어·백그라운드 기능은 브라우저별 지원 범위가 다르다. 그 초기화가
  // 실패하더라도 검색/URL/내비게이션 같은 기본 입력은 먼저 사용할 수 있어야 한다.
  bindEvents();
  bindGateEvents();
  registerServiceWorker();
  initMediaSession({
    onPlay: async () => {
      resumeFromMediaSessionControl("mediasession-play");
    },
    onPause: async () => {
      // #region agent log
      debugBg("H-64", "app.js:initMediaSession", "mediasession-pause-real-pause", {
        visibility: document.visibilityState,
        hiddenPinned: isHiddenSilentMediaSessionPinned(),
      });
      // #endregion
      pauseByUser();
    },
    onNext: () => playNext(true),
    onPrev: () => playPrev(true),
  });
  initBackgroundPlayback({
    pauseForBackground,
    shouldResume: shouldResumeAfterVisible,
    shouldWatchdogResume: shouldBgWatchdogResume,
    shouldKeepBgSessionAlive,
    onPauseSessionHeartbeat: () => {
      ensureBgPauseAvSession();
      syncMediaSession();
    },
    resumePlayback: resumeIfPlaying,
    prepareForBackground,
    restoreAudioOnForeground: syncAudioOnForeground,
  });
  window.addEventListener("keydown", (e) => {
    if (e.code !== "MediaPlayPause" && e.code !== "Pause") return;
    if (playing) {
      pauseByUser();
    } else {
      resumeByUser();
    }
  });
  if (new URLSearchParams(location.search).has("debug")) {
    clearBgDebugLog();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") renderBgDebugPanel();
    });
    window.addEventListener("pageshow", renderBgDebugPanel);
    setInterval(renderBgDebugPanel, 500);
  }

  setProgressHandler((cur, dur) => {
    if (WATCH_APP_MODE) updateWatchEndGuard(cur, dur);
    if (progressScrubbing) return;
    const holdPos = getBgPauseHoldPosition();
    if (holdPos != null) {
      setProgressUI(holdPos, dur);
      if (dur > 0) {
        updateMediaPosition({
          duration: dur,
          position: holdPos,
          rate: isHiddenSilentMediaSessionPinned() ? 0.000001 : 1,
        });
      }
      return;
    }
    const frozenPos = getBgVirtualPausePosition();
    if (frozenPos != null) {
      setProgressUI(frozenPos, dur);
      if (dur > 0) {
        updateMediaPosition({
          duration: dur,
          position: frozenPos,
          rate: isHiddenSilentMediaSessionPinned() ? 0.000001 : 1,
        });
      }
      return;
    }
    setProgressUI(cur, dur);
    if (playing || document.visibilityState === "hidden") {
      updateMediaPosition({ duration: dur, position: cur });
    }
  });
  setTrackEndHandler(() => {
    if (!WATCH_APP_MODE) return;
    void (async () => {
      const item = getNowPlayingItem();
      if (watchAutoplayOn && item?.vid && (await playWatchAutoplayNext(item))) return;
      await showWatchEndScreen();
    })();
  });
  $("btnWatchAutoplay")?.addEventListener("click", toggleWatchAutoplay);
  $("btnRecoRefresh")?.addEventListener("click", () => void renderRecoScreen({ refresh: true }));
  $("btnChannelSubscribe")?.addEventListener("click", toggleViewedChannelSubscription);
  if (WATCH_APP_MODE) {
    loadWatchAutoplay();
    positionWatchAutoplay();
    window.addEventListener("resize", positionWatchAutoplay);
  }
  if (WATCH_APP_MODE) ensureWatchTitleShield();

  setPlayingChangeHandler((on) => {
    playing = on;
    renderNowPlaying();
    renderHomeQueue();
    renderLibraryQueue();
    if (on) {
      if (WATCH_APP_MODE) {
        hideWatchEndScreen();
        forceWatchNoRepeat();
      }
      maybeShowMaxQualityTip();
      startBackgroundKeepAlive();
    } else if (document.visibilityState === "visible") {
      stopBackgroundKeepAlive();
    }
  });

  bindWithdrawUI({
    onToast: toast,
    onDone: async () => {
      await refreshAccess();
      updateGate();
      renderAll();
    },
  });
  subscribe(() => renderAll());

  try {
    const authReady = initAuth();
    await refreshAccess();
    if (getAccessState().publicAccess && !getAccessState().loggedIn) {
      gateReady = true;
      updateGate();
    }
    await authReady;
    const authResult = await handleAuthRedirectQuery();
    if (authResult === "ok") {
      toast("로그인 성공");
      showScreen("home");
    }
    if (authResult === "fail") toast("로그인 실패");
    hookAutoSync();
    onAuthChange(async (user) => {
      renderAuthUI();
      await refreshAccess();
      updateGate();
      if (user && canUseApp()) {
        if (appServicesStarted) {
          await syncOnLogin();
          applyStartupSession();
        } else {
          await startAppServices();
        }
        renderAll();
      }
    });
    onAccessChange(() => {
      renderAuthUI();
      updateGate();
    });

    renderAll();
    renderAuthUI();
  } catch (err) {
    console.error("boot failed", err);
    toast("앱 초기화 중 오류가 발생했습니다");
  } finally {
    gateReady = true;
    // gateReady가 true가 된 뒤에 게이트를 다시 평가해야 비로그인(공개 모드)
    // 방문자도 앱 서비스가 시작된다. onAuthChange는 user가 있을 때만 시작한다.
    if (updateGate()) {
      try {
        await startAppServices();
        renderAll();
      } catch (err) {
        console.error("app services failed", err);
      }
    }
  }
}

syncViewportLayout();
boot();
