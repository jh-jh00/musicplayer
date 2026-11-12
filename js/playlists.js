const STORAGE_KEY = "yt_player_v4";
const UI_THEME_STORAGE_KEY = "yt_player_ui_theme";
export const WATCH_HISTORY_MAX = 100;
export const WAITING_QUEUE_ID = "__waiting__";

export const DEFAULT_STATE = {
  activePlaylistId: null,
  activeMode: "music",
  volume: 100,
  volumeTouched: false,
  defaultMode: "music",
  defaultRepeat: "all",
  uiTheme: "default",
  videoQuality: "auto",
  playlists: [],
  subscriptions: [],
  lastPlayed: null,
  watchHistory: [],
  waitingQueue: { items: [], cur: 0, repeat: "all", shuffle: false, shuffleOrder: [], preShuffleItems: null },
  playbackSource: "playlist",
  sessionQueue: null,
  ownerUid: null,
};

function cloneState(value) {
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

let playbackMode = "library";
let state = loadRaw();
let listeners = new Set();
let playbackBackStack = [];
// 새로고침하면 사라지지 않도록 상태에 저장해 둔 값에서 시작한다.
// (이게 없으면 다시 들어왔을 때 재생목록의 옛 위치가 `지금 재생` 으로 뜬다)
let lastPlayedTrack = state.lastPlayed?.vid ? { ...state.lastPlayed } : null;
let backStackPushSuppressCount = 0;
let awaitingSessionStartVid = null;
let forwardStack = [];
const PLAYBACK_BACK_STACK_MAX = 200;

function trimWatchHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.length > WATCH_HISTORY_MAX ? history.slice(0, WATCH_HISTORY_MAX) : history;
}

function defaultWaitingQueue(repeat = state.defaultRepeat || "all") {
  return { items: [], cur: 0, repeat, shuffle: false, shuffleOrder: [], preShuffleItems: null };
}

function normalizeWaitingQueue(raw, fallbackRepeat = "all") {
  if (!raw || !Array.isArray(raw.items)) return defaultWaitingQueue(fallbackRepeat);
  const normalized = {
    items: raw.items,
    cur: raw.cur ?? 0,
    repeat: raw.repeat ?? fallbackRepeat,
    shuffle: Boolean(raw.shuffle),
    shuffleOrder: Array.isArray(raw.shuffleOrder) ? raw.shuffleOrder : [],
    preShuffleItems: Array.isArray(raw.preShuffleItems) ? raw.preShuffleItems : null,
  };
  if (normalized.shuffle && !normalized.preShuffleItems?.length) {
    normalized.shuffle = false;
  }
  return normalized;
}

function loadRaw() {
  try {
    let raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!raw) raw = JSON.parse(localStorage.getItem("yt_player_v3") || "null");
    if (!raw || !Array.isArray(raw.playlists)) return cloneState(DEFAULT_STATE);
    const defaultRepeat = raw.defaultRepeat || "all";
    const storedTheme = normalizeUiThemeStored(raw.uiTheme);
    let preferredTheme = readUiThemePreference();
    if (!preferredTheme && storedTheme !== "default") {
      writeUiThemePreference(storedTheme);
      preferredTheme = storedTheme;
    }
    return {
      ...cloneState(DEFAULT_STATE),
      ...raw,
      playlists: raw.playlists.filter(pl => pl?.id && Array.isArray(pl.items)),
      subscriptions: Array.isArray(raw.subscriptions) ? raw.subscriptions : [],
      lastPlayed: raw.lastPlayed?.vid ? raw.lastPlayed : null,
      watchHistory: trimWatchHistory(raw.watchHistory),
      uiTheme: preferredTheme || storedTheme,
      videoQuality: raw.videoQuality || "auto",
      waitingQueue: normalizeWaitingQueue(raw.waitingQueue, defaultRepeat),
      playbackSource: raw.playbackSource === "waiting" ? "waiting" : "playlist",
      sessionQueue: null,
      ownerUid: raw.ownerUid ?? null,
    };
  } catch {
    return cloneState(DEFAULT_STATE);
  }
}

export function getOwnerUid() {
  return state.ownerUid ?? null;
}

export function setOwnerUid(uid) {
  if (state.ownerUid === (uid ?? null)) return;
  saveState({ ...state, ownerUid: uid ?? null });
}

export function resetLocalLibrary(uid = null) {
  const fresh = cloneState(DEFAULT_STATE);
  fresh.ownerUid = uid ?? null;
  fresh.volume = state.volume;
  fresh.volumeTouched = Boolean(state.volumeTouched);
  fresh.defaultMode = state.defaultMode;
  fresh.defaultRepeat = state.defaultRepeat;
  fresh.uiTheme = state.uiTheme;
  fresh.videoQuality = state.videoQuality;
  fresh.activeMode = state.activeMode;
  fresh.waitingQueue = defaultWaitingQueue(fresh.defaultRepeat);
  fresh.playbackSource = "playlist";
  saveState(fresh);
  ensureDefaultPlaylist();
}

export function getState() {
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  listeners.forEach((fn) => fn(state));
}

export function saveState(next) {
  state = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Keep playback usable when storage is blocked or full.
  }
  notify();
}

export function patchState(partial) {
  saveState({ ...state, ...partial });
}

export function setUiThemePreference(theme) {
  const uiTheme = normalizeUiThemeStored(theme);
  writeUiThemePreference(uiTheme);
  patchState({ uiTheme });
}

export function uid(prefix = "pl") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function getActivePlaylist() {
  if (!state.activePlaylistId) return null;
  return state.playlists.find((p) => p.id === state.activePlaylistId) || null;
}

export function ensureDefaultPlaylist() {
  if (state.playlists.length) return;
  const pl = createPlaylist("내 재생목록");
  patchState({ activePlaylistId: pl.id });
}

export function createPlaylist(name) {
  const pl = {
    id: uid(),
    name: name.trim() || "새 재생목록",
    items: [],
    cur: 0,
    repeat: state.defaultRepeat || "all",
    shuffle: false,
    shuffleOrder: [],
  };
  saveState({ ...state, playlists: [...state.playlists, pl], activePlaylistId: pl.id });
  return pl;
}

export function deletePlaylist(id) {
  const playlists = state.playlists.filter((p) => p.id !== id);
  const activePlaylistId =
    state.activePlaylistId === id ? playlists[0]?.id || null : state.activePlaylistId;
  saveState({ ...state, playlists, activePlaylistId });
}

export function renamePlaylist(id, name) {
  const playlists = state.playlists.map((p) =>
    p.id === id ? { ...p, name: name.trim() || p.name } : p
  );
  saveState({ ...state, playlists });
}

export function setActivePlaylist(id) {
  patchState({ activePlaylistId: id, sessionQueue: null });
}

export function ensureWaitingQueue() {
  if (!state.waitingQueue?.items) {
    patchState({ waitingQueue: defaultWaitingQueue() });
  }
}

export function getWaitingQueueAsPlaylist() {
  ensureWaitingQueue();
  const q = state.waitingQueue;
  return {
    id: WAITING_QUEUE_ID,
    name: "대기중인 음악",
    items: q.items,
    cur: q.cur ?? 0,
    repeat: q.repeat ?? state.defaultRepeat ?? "all",
    shuffle: Boolean(q.shuffle),
    shuffleOrder: q.shuffleOrder ?? [],
    preShuffleItems: q.preShuffleItems ?? null,
  };
}

function cloneQueueItems(items) {
  return (items || []).map((item) => ({ ...item }));
}

function shuffleQueueSlice(items) {
  const shuffled = cloneQueueItems(items);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function restoreQueueFromPreShuffle(currentItems, preShuffleItems) {
  if (!preShuffleItems?.length) return currentItems;
  const byVid = new Map(currentItems.map((item) => [item.vid, item]));
  const preVids = new Set(preShuffleItems.map((item) => item.vid));
  const restored = preShuffleItems
    .filter((item) => byVid.has(item.vid))
    .map((item) => byVid.get(item.vid));
  const extras = currentItems.filter((item) => !preVids.has(item.vid));
  return [...restored, ...extras];
}

function syncPreShuffleAfterRemoval(preShuffleItems, removedVid) {
  if (!preShuffleItems?.length || !removedVid) return preShuffleItems;
  const next = preShuffleItems.filter((item) => item.vid !== removedVid);
  return next.length ? next : null;
}

function disableWaitingQueueShuffle(q) {
  const restored = restoreQueueFromPreShuffle(q.items, q.preShuffleItems);
  const curVid = q.items[q.cur ?? 0]?.vid;
  let cur = q.cur ?? 0;
  if (curVid) {
    const idx = restored.findIndex((item) => item.vid === curVid);
    if (idx >= 0) cur = idx;
  }
  return {
    ...q,
    items: restored,
    cur,
    shuffle: false,
    shuffleOrder: [],
    preShuffleItems: null,
  };
}

/** 다음 재생 대기열 셔플 토글 — 켜면 무작위 순서, 끄면 원래 순서 복원, 다시 켜면 새 무작위 순서 */
export function toggleWaitingQueueShuffle() {
  ensureWaitingQueue();
  const q = state.waitingQueue;
  if (!q.items.length) return false;

  if (q.shuffle) {
    patchState({ waitingQueue: disableWaitingQueueShuffle(q) });
    return false;
  }

  const preShuffleItems = cloneQueueItems(q.items);
  const cur = q.cur ?? 0;
  let items;
  if (isQueuePlaybackMode() && cur < q.items.length) {
    const head = q.items.slice(0, cur + 1);
    const tail = shuffleQueueSlice(q.items.slice(cur + 1));
    items = [...head, ...tail];
  } else {
    items = shuffleQueueSlice(q.items);
  }

  patchState({
    waitingQueue: {
      ...q,
      items,
      shuffle: true,
      shuffleOrder: [],
      preShuffleItems,
    },
  });
  return true;
}

export function useWaitingQueuePlayback() {
  ensureWaitingQueue();
  enterQueuePlaybackMode();
  patchState({ playbackSource: "waiting", sessionQueue: null });
}

export function usePlaylistPlayback() {
  patchState({ playbackSource: "playlist" });
}

export function hasWaitingQueueItems() {
  ensureWaitingQueue();
  return (state.waitingQueue?.items?.length ?? 0) > 0;
}

export function isQueuePlaybackMode() {
  return playbackMode === "waiting";
}

export function shouldUseQueueTransport() {
  return isWaitingQueueActive();
}

export function enterQueuePlaybackMode() {
  playbackMode = "waiting";
}

export function leaveQueuePlaybackMode() {
  playbackMode = "library";
  forwardStack = [];
}

export function hasForwardQueuedTrack() {
  return forwardStack.length > 0;
}

export function pushForwardTrack(item) {
  if (!item?.vid) return;
  forwardStack.push({ ...item });
}

export function takeForwardTrack() {
  return forwardStack.pop() || null;
}

export function isWaitingQueueActive() {
  return isQueuePlaybackMode() && hasWaitingQueueItems();
}

export function getPlaybackPlaylist() {
  if (state.sessionQueue?.items?.length) return state.sessionQueue;
  if (isQueuePlaybackMode() && hasWaitingQueueItems()) {
    return getWaitingQueueAsPlaylist();
  }
  return getActivePlaylist();
}

export function normalizeTrackArt(item) {
  if (!item?.vid) return item;
  if (item.art) return item;
  return {
    ...item,
    art: `https://img.youtube.com/vi/${item.vid}/mqdefault.jpg`,
  };
}

/** UI·일시정지 후 재개용 — 방금 재생 중이던 곡 (대기열 소진 후 재생목록 0번으로 튀는 것 방지) */
export function getNowPlayingItem() {
  if (state.sessionQueue?.items?.length) {
    return normalizeTrackArt(getCurrentItem(state.sessionQueue));
  }
  if (isQueuePlaybackMode() && hasWaitingQueueItems()) {
    return normalizeTrackArt(getCurrentItem(getWaitingQueueAsPlaylist()));
  }
  if (lastPlayedTrack?.vid) return normalizeTrackArt(lastPlayedTrack);
  return normalizeTrackArt(getCurrentItem(getActivePlaylist()));
}

export function clearSessionQueue() {
  if (state.sessionQueue) patchState({ sessionQueue: null });
}

export function setSessionQueue(items, cur = 0) {
  const rows = (items || []).filter((item) => item?.vid);
  if (!rows.length) return;
  patchState({
    sessionQueue: {
      id: "__session__",
      name: "지금 재생",
      items: rows,
      cur,
      repeat: state.defaultRepeat || "all",
      shuffle: false,
      shuffleOrder: [],
    },
  });
}

export function updatePlaybackPlaylist(updater) {
  if (state.sessionQueue?.items?.length) {
    patchState({ sessionQueue: updater({ ...state.sessionQueue }) });
    return;
  }
  if (isWaitingQueueActive()) {
    const pl = getWaitingQueueAsPlaylist();
    const updated = updater(pl);
    patchState({
      waitingQueue: {
        ...state.waitingQueue,
        items: updated.items,
        cur: updated.cur,
        repeat: updated.repeat,
        shuffle: updated.shuffle,
        shuffleOrder: updated.shuffleOrder,
        preShuffleItems: updated.preShuffleItems ?? null,
      },
    });
    return;
  }
  const pl = getActivePlaylist();
  if (pl) updatePlaylist(pl.id, updater);
}

export async function addUrlsToWaitingQueue(urls) {
  const lines = urls.filter(Boolean);
  const added = [];
  let skippedUnavailable = 0;
  let importDuplicates = 0;
  for (const line of lines) {
    const { items, skipped, duplicates } = await resolveUrlToItems(line);
    skippedUnavailable += skipped;
    importDuplicates += duplicates;
    added.push(...items);
  }
  if (!added.length) {
    return { added: 0, skippedUnavailable, importDuplicates, skippedDuplicate: 0 };
  }
  const { added: n, skippedDuplicate } = addItemsToWaitingQueue(added);
  return { added: n, skippedUnavailable, importDuplicates, skippedDuplicate };
}

export function addItemsToWaitingQueue(items) {
  ensureWaitingQueue();
  const rows = (items || []).filter((item) => item?.vid);
  const { toAdd, skippedDuplicate } = filterNewWaitingQueueItems(rows);
  if (!toAdd.length) return { added: 0, skippedDuplicate };
  const q = state.waitingQueue;
  const preShuffleItems =
    q.shuffle && q.preShuffleItems
      ? [...q.preShuffleItems, ...cloneQueueItems(toAdd)]
      : q.preShuffleItems;
  patchState({
    waitingQueue: {
      ...q,
      items: [...q.items, ...toAdd],
      preShuffleItems,
    },
    playbackSource: "waiting",
  });
  return { added: toAdd.length, skippedDuplicate };
}

export function removeWaitingQueueItem(index) {
  ensureWaitingQueue();
  const q = state.waitingQueue;
  const items = q.items.filter((_, i) => i !== index);
  let cur = q.cur;
  if (cur === index) cur = Math.min(cur, Math.max(0, items.length - 1));
  else if (cur > index) cur -= 1;
  const removed = q.items[index];
  let next = { ...q, items, cur };
  if (q.shuffle && q.preShuffleItems) {
    next.preShuffleItems = syncPreShuffleAfterRemoval(q.preShuffleItems, removed?.vid);
    if (!items.length) next = disableWaitingQueueShuffle({ ...next, items, cur });
  }
  const patch = { waitingQueue: next };
  if (!items.length) {
    if (state.playbackSource === "waiting") patch.playbackSource = "playlist";
    leaveQueuePlaybackMode();
  }
  patchState(patch);
}

export function hasUpcomingWaitingTracks() {
  if (!hasWaitingQueueItems()) return false;
  const q = state.waitingQueue;
  const cur = q.cur ?? 0;
  return cur < q.items.length - 1;
}

export function hasPreviousPlayedTrack() {
  return playbackBackStack.length > 0;
}

export function getPlaybackBackStackLength() {
  return playbackBackStack.length;
}

/** 재생을 마친(또는 건너뛴) 곡을 이력 스택에 추가 */
export function commitPlayedTrackToHistory(item) {
  if (!item?.vid) return;
  if (backStackPushSuppressCount > 0) return;
  if (awaitingSessionStartVid) return;
  const top = playbackBackStack[playbackBackStack.length - 1];
  if (top?.vid === item.vid) return;
  playbackBackStack.push({ ...item });
  if (playbackBackStack.length > PLAYBACK_BACK_STACK_MAX) playbackBackStack.shift();
}

export function clearPlaybackBackStack({ keepLastPlayed = true } = {}) {
  playbackBackStack = [];
  if (!keepLastPlayed) {
    lastPlayedTrack = null;
    if (state.lastPlayed) patchState({ lastPlayed: null });
  }
  backStackPushSuppressCount = 0;
  awaitingSessionStartVid = null;
}

function beginPlaybackSession(startVid) {
  clearPlaybackBackStack();
  forwardStack = [];
  awaitingSessionStartVid = startVid || null;
  enterQueuePlaybackMode();
}

/** 보관함/검색 재생 — 다음 재생 대기열은 건드리지 않음 */
export function beginLibraryPlaybackSession(startVid) {
  clearPlaybackBackStack();
  forwardStack = [];
  awaitingSessionStartVid = startVid || null;
  leaveQueuePlaybackMode();
  usePlaylistPlayback();
}

export function replaceCurrentQueueTrack(item) {
  ensureWaitingQueue();
  if (!item?.vid) return -1;
  const q = state.waitingQueue;
  const cur = q.cur ?? 0;
  if (!q.items.length || cur >= q.items.length) return -1;
  const items = [...q.items];
  items[cur] = { ...item };
  patchState({
    waitingQueue: { ...q, items, shuffleOrder: [] },
    playbackSource: "waiting",
  });
  return cur;
}

export function suppressBackStackPushOnce() {
  backStackPushSuppressCount += 1;
}

export function noteTrackPlaybackStarted(item) {
  if (!item?.vid) return;
  if (state.lastPlayed?.vid !== item.vid) patchState({ lastPlayed: { ...item } });
  if (awaitingSessionStartVid) {
    awaitingSessionStartVid = null;
    lastPlayedTrack = { ...item };
    return;
  }
  if (backStackPushSuppressCount > 0) {
    backStackPushSuppressCount -= 1;
    lastPlayedTrack = { ...item };
    return;
  }
  lastPlayedTrack = { ...item };
}

export function markQueueTrackIntent(vid) {
  if (awaitingSessionStartVid && vid && vid === awaitingSessionStartVid) {
    awaitingSessionStartVid = null;
  }
}

export function takePreviousPlayedTrack() {
  return playbackBackStack.pop() || null;
}

export function insertWaitingQueueItemAt(index, item) {
  ensureWaitingQueue();
  if (!item?.vid) return false;
  const q = state.waitingQueue;
  const items = [...q.items];
  const at = Math.max(0, Math.min(index, items.length));
  items.splice(at, 0, item);
  patchState({
    waitingQueue: {
      ...q,
      items,
      cur: at,
      shuffleOrder: [],
    },
    playbackSource: "waiting",
  });
  return true;
}

/** 재생 이력에서 꺼낸 곡을 현재 곡 앞에 넣고 그 위치로 cur 설정 (레거시 — 사용 금지) */
export function insertPreviousTrackInWaitingQueue(prev) {
  return replaceCurrentQueueTrack(prev);
}

export function loadPlaylistIntoWaitingQueue(playlist, startIndex = 0) {
  if (!playlist?.items?.length) return false;
  ensureWaitingQueue();
  const start = Math.max(0, Math.min(startIndex, playlist.items.length - 1));
  const item = playlist.items[start];
  if (!item?.vid) return false;
  const repeat = state.waitingQueue?.repeat ?? state.defaultRepeat ?? "all";
  const items =
    repeat === "all"
      ? [...playlist.items.slice(start), ...playlist.items.slice(0, start)]
      : playlist.items.slice(start);
  beginPlaybackSession(item.vid);
  patchState({
    waitingQueue: {
      ...state.waitingQueue,
      items,
      cur: 0,
      shuffle: false,
      shuffleOrder: [],
      preShuffleItems: null,
      repeat,
    },
    playbackSource: "waiting",
    sessionQueue: null,
  });
  return true;
}

export function replaceWaitingQueueWithItems(items) {
  const rows = (items || []).filter((item) => item?.vid);
  if (!rows.length) return false;
  beginPlaybackSession(rows[0].vid);
  ensureWaitingQueue();
  patchState({
    waitingQueue: {
      ...state.waitingQueue,
      items: rows,
      cur: 0,
      shuffle: false,
      shuffleOrder: [],
      preShuffleItems: null,
      repeat: state.waitingQueue?.repeat ?? state.defaultRepeat ?? "all",
    },
    playbackSource: "waiting",
    sessionQueue: null,
  });
  return true;
}

/** 재생이 끝난(또는 건너뛴) 현재 곡을 대기열에서 제거 */
export function finishWaitingQueueTrack() {
  if (!hasWaitingQueueItems()) return false;
  const q = state.waitingQueue;
  if (!q.items.length) return false;
  const idx = Math.min(q.cur, q.items.length - 1);
  const leaving = q.items[idx];
  if (leaving?.vid) commitPlayedTrackToHistory(leaving);
  const items = q.items.filter((_, i) => i !== idx);
  const cur = idx >= items.length ? Math.max(0, items.length - 1) : idx;
  let nextQueue = { ...q, items, cur, shuffleOrder: [] };
  if (q.shuffle && q.preShuffleItems) {
    nextQueue.preShuffleItems = syncPreShuffleAfterRemoval(q.preShuffleItems, leaving?.vid);
    if (!items.length) nextQueue = disableWaitingQueueShuffle(nextQueue);
  }
  const patch = { waitingQueue: nextQueue };
  if (!items.length) {
    patch.playbackSource = "playlist";
    leaveQueuePlaybackMode();
  }
  patchState(patch);
  return items.length > 0;
}

/** 전체 반복: 현재 곡을 대기열 맨 아래로 보내고 다음 곡(cur) 재생 */
export function rotateWaitingQueueTrackToEnd() {
  if (!hasWaitingQueueItems()) return false;
  const q = state.waitingQueue;
  const idx = Math.min(q.cur ?? 0, q.items.length - 1);
  const current = q.items[idx];
  if (current?.vid) commitPlayedTrackToHistory(current);
  const items = [...q.items];
  const [moved] = items.splice(idx, 1);
  const cur = idx >= items.length ? 0 : idx;
  items.push(moved);
  patchState({
    waitingQueue: { ...q, items, cur, shuffleOrder: [] },
    playbackSource: "waiting",
  });
  return true;
}

/** 대기열에서 특정 인덱스로 재생할 때 건너뛴 곡 제거 */
export function prepareWaitingQueuePlayIndex(targetIndex) {
  if (!hasWaitingQueueItems()) return targetIndex;
  const q = state.waitingQueue;
  const cur = q.cur ?? 0;
  if (targetIndex === cur) return cur;
  if (targetIndex > cur) {
    const items = q.items.filter((_, i) => i < cur || i >= targetIndex);
    patchState({
      waitingQueue: { ...q, items, cur, shuffleOrder: [] },
    });
    return cur;
  }
  patchState({ waitingQueue: { ...q, cur: targetIndex } });
  return targetIndex;
}

export function moveWaitingQueueItem(index, delta) {
  ensureWaitingQueue();
  const q = state.waitingQueue;
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= q.items.length) return;
  reorderWaitingQueueItem(index, nextIndex);
}

export function reorderWaitingQueueItem(fromIndex, toIndex) {
  ensureWaitingQueue();
  const q = state.waitingQueue;
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= q.items.length || toIndex >= q.items.length) {
    return;
  }
  const items = [...q.items];
  const [moved] = items.splice(fromIndex, 1);
  items.splice(toIndex, 0, moved);
  let cur = q.cur;
  if (cur === fromIndex) cur = toIndex;
  else if (fromIndex < cur && toIndex >= cur) cur -= 1;
  else if (fromIndex > cur && toIndex <= cur) cur += 1;
  patchState({
    waitingQueue: disableWaitingQueueShuffle({ ...q, items, cur }),
  });
}

export function clearWaitingQueue() {
  clearPlaybackBackStack();
  leaveQueuePlaybackMode();
  patchState({
    waitingQueue: defaultWaitingQueue(),
    playbackSource: "playlist",
  });
}

export function searchWaitingQueue(query) {
  return searchItems(getWaitingQueueAsPlaylist(), query);
}

export function addToWatchHistory(item) {
  if (!item?.vid) return;
  const entry = {
    vid: item.vid,
    title: item.title || "유튜브 영상",
    artist: item.artist || "YouTube",
    art: item.art || `https://img.youtube.com/vi/${item.vid}/mqdefault.jpg`,
    watchedAt: Date.now(),
  };
  let history = (state.watchHistory || []).filter((h) => h.vid !== item.vid);
  history.unshift(entry);
  if (history.length > WATCH_HISTORY_MAX) history = history.slice(0, WATCH_HISTORY_MAX);
  patchState({ watchHistory: history });
}

export function clearWatchHistory() {
  patchState({ watchHistory: [] });
}

export function removeFromWatchHistory(vid) {
  patchState({ watchHistory: (state.watchHistory || []).filter((h) => h.vid !== vid) });
}

export function searchWatchHistory(query) {
  const q = (query || "").trim().toLowerCase();
  const rows = state.watchHistory || [];
  if (!q) return rows.map((item, index) => ({ item, index }));
  return rows
    .map((item, index) => ({ item, index }))
    .filter(
      ({ item }) =>
        item.title.toLowerCase().includes(q) ||
        item.artist.toLowerCase().includes(q) ||
        item.vid.toLowerCase().includes(q)
    );
}

export function updatePlaylist(id, updater) {
  const playlists = state.playlists.map((p) => (p.id === id ? updater({ ...p }) : p));
  saveState({ ...state, playlists });
}

export function parseVideoId(input) {
  const s = (input || "").trim();
  if (!s) return null;
  if (/^[\w-]{11}$/.test(s)) return s;
  const patterns = [/[?&]v=([\w-]{11})/, /youtu\.be\/([\w-]{11})/, /\/(?:embed|shorts|v|live)\/([\w-]{11})/];
  for (const p of patterns) {
    const m = s.match(p);
    if (m) return m[1];
  }
  return null;
}

export function parsePlaylistId(input) {
  const s = (input || "").trim();
  if (!s) return null;
  if (/^PL[\w-]+$/i.test(s)) return s;
  const m = s.match(/[?&]list=(PL[\w-]+)/i);
  return m ? m[1] : null;
}

export function parseChannelRef(input) {
  const s = (input || "").trim();
  if (!s) return null;

  let m = s.match(/youtube\.com\/channel\/(UC[\w-]+)/i);
  if (m) return { channelId: m[1] };

  m = s.match(/youtube\.com\/@([\w.-]+)/i);
  if (m) return { handle: m[1] };

  if (/^UC[\w-]{22}$/.test(s)) return { channelId: s };
  if (s.startsWith("@")) return { handle: s.slice(1) };

  return null;
}

async function fetchMetaFromApi(vid) {
  const { fetchVideoMeta, isSearchConfigured } = await import("./youtube-api.js");
  if (!isSearchConfigured()) return null;
  const { items } = await fetchVideoMeta([vid]);
  return items[0] || null;
}

export async function fetchMeta(vid) {
  const base = {
    vid,
    title: "유튜브 영상",
    artist: "YouTube",
    art: `https://img.youtube.com/vi/${vid}/mqdefault.jpg`,
  };

  const fromApi = await fetchMetaFromApi(vid);
  if (fromApi) return fromApi;

  try {
    const res = await fetch(
      `https://noembed.com/embed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${vid}`)}`
    );
    const j = await res.json();
    if (j?.title) {
      base.title = j.title;
      base.artist = j.author_name || "YouTube";
    }
  } catch {}
  return base;
}

async function resolveUrlToItems(line) {
  const empty = { items: [], skipped: 0, duplicates: 0 };
  const playlistId = parsePlaylistId(line);
  if (playlistId) {
    const { fetchPlaylistItems, isSearchConfigured } = await import("./youtube-api.js");
    if (!isSearchConfigured()) return empty;
    const { items, skipped, duplicates, error } = await fetchPlaylistItems(playlistId, 500);
    if (error) return empty;
    return { items, skipped: skipped || 0, duplicates: duplicates || 0 };
  }

  const channel = parseChannelRef(line);
  if (channel) {
    const { fetchChannelVideos, isSearchConfigured } = await import("./youtube-api.js");
    if (!isSearchConfigured()) return empty;
    const { items, skipped, duplicates, error } = await fetchChannelVideos(channel, 500);
    if (error) return empty;
    return { items, skipped: skipped || 0, duplicates: duplicates || 0 };
  }

  const vid = parseVideoId(line);
  if (!vid) return empty;
  return { items: [await fetchMeta(vid)], skipped: 0, duplicates: 0 };
}

export async function resolveUrlsToItems(urls) {
  const lines = urls.filter(Boolean);
  const items = [];
  let skippedUnavailable = 0;
  let importDuplicates = 0;
  for (const line of lines) {
    const result = await resolveUrlToItems(line);
    skippedUnavailable += result.skipped || 0;
    importDuplicates += result.duplicates || 0;
    items.push(...result.items);
  }
  return { items, skippedUnavailable, importDuplicates };
}

function filterNewWaitingQueueItems(rows) {
  ensureWaitingQueue();
  const from = hasWaitingQueueItems() ? (state.waitingQueue?.cur ?? 0) : 0;
  const seen = new Set();
  for (let i = from; i < state.waitingQueue.items.length; i++) {
    seen.add(state.waitingQueue.items[i].vid);
  }
  const toAdd = [];
  let skippedDuplicate = 0;
  for (const item of rows) {
    if (!item?.vid) continue;
    if (seen.has(item.vid)) {
      skippedDuplicate += 1;
      continue;
    }
    seen.add(item.vid);
    toAdd.push(item);
  }
  return { toAdd, skippedDuplicate };
}

function filterNewPlaylistItems(playlistId, rows) {
  const pl = state.playlists.find((p) => p.id === playlistId);
  const seen = new Set((pl?.items || []).map((i) => i.vid));
  const toAdd = [];
  let skippedDuplicate = 0;
  for (const item of rows) {
    if (!item?.vid) continue;
    if (seen.has(item.vid)) {
      skippedDuplicate += 1;
      continue;
    }
    seen.add(item.vid);
    toAdd.push(item);
  }
  return { toAdd, skippedDuplicate };
}

export async function addUrlsToPlaylist(playlistId, urls) {
  const lines = urls.filter(Boolean);
  const added = [];
  let skippedUnavailable = 0;
  let importDuplicates = 0;
  for (const line of lines) {
    const { items, skipped, duplicates } = await resolveUrlToItems(line);
    skippedUnavailable += skipped;
    importDuplicates += duplicates;
    added.push(...items);
  }
  if (!added.length) {
    return { added: 0, skippedUnavailable, importDuplicates, skippedDuplicate: 0 };
  }
  const { added: n, skippedDuplicate } = addItemsToPlaylist(playlistId, added);
  return { added: n, skippedUnavailable, importDuplicates, skippedDuplicate };
}

export function addItemsToPlaylist(playlistId, items) {
  const rows = (items || []).filter((item) => item?.vid);
  const { toAdd, skippedDuplicate } = filterNewPlaylistItems(playlistId, rows);
  if (!toAdd.length) return { added: 0, skippedDuplicate };
  updatePlaylist(playlistId, (p) => ({ ...p, items: [...p.items, ...toAdd] }));
  return { added: toAdd.length, skippedDuplicate };
}

export function findItemIndex(playlist, vid) {
  if (!playlist?.items?.length || !vid) return -1;
  return playlist.items.findIndex((item) => item.vid === vid);
}

/** 현재 곡(cur) 이후 대기열에 같은 vid가 있는지 (다음 재생 중복 검사용) */
export function findWaitingQueueIndexFromCur(vid) {
  ensureWaitingQueue();
  const q = state.waitingQueue;
  if (!q?.items?.length || !vid) return -1;
  const from = hasWaitingQueueItems() ? (q.cur ?? 0) : 0;
  for (let i = from; i < q.items.length; i++) {
    if (q.items[i]?.vid === vid) return i;
  }
  return -1;
}

export function removeItem(playlistId, index) {
  updatePlaylist(playlistId, (p) => {
    const items = p.items.filter((_, i) => i !== index);
    let cur = p.cur;
    if (cur === index) cur = Math.min(cur, Math.max(0, items.length - 1));
    else if (cur > index) cur -= 1;
    return { ...p, items, cur };
  });
}

export function setCurrentIndex(playlistId, index) {
  updatePlaylist(playlistId, (p) => ({ ...p, cur: index }));
}

export function getCurrentItem(playlist) {
  if (!playlist?.items?.length) return null;
  const idx = Math.min(Math.max(0, playlist.cur), playlist.items.length - 1);
  return playlist.items[idx] || null;
}

export function searchItems(playlist, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return playlist.items.map((item, index) => ({ item, index }));
  return playlist.items
    .map((item, index) => ({ item, index }))
    .filter(
      ({ item }) =>
        item.title.toLowerCase().includes(q) ||
        item.artist.toLowerCase().includes(q) ||
        item.vid.toLowerCase().includes(q)
    );
}

export function exportStateForSync() {
  const s = cloneState(state);
  delete s.sessionQueue;
  delete s.ownerUid;
  delete s.activeMode;
  return s;
}

function normalizePlaybackModeStored(mode) {
  return mode === "video" ? "video" : "music";
}

function normalizeUiThemeStored(theme) {
  return theme === "ipod" || theme === "gameboy" ? theme : "default";
}

function readUiThemePreference() {
  try {
    const value = localStorage.getItem(UI_THEME_STORAGE_KEY);
    return value === "default" || value === "ipod" || value === "gameboy" ? value : null;
  } catch {
    return null;
  }
}

function writeUiThemePreference(theme) {
  try {
    localStorage.setItem(UI_THEME_STORAGE_KEY, normalizeUiThemeStored(theme));
  } catch {
    /* local state still retains the selected theme */
  }
}

export function importStateFromSync(remote) {
  if (!remote || !Array.isArray(remote.playlists)) return;
  const owner = state.ownerUid ?? null;
  const preferredTheme = readUiThemePreference();
  const merged = {
    ...cloneState(DEFAULT_STATE),
    ...remote,
    playlists: remote.playlists.filter(pl => pl?.id && Array.isArray(pl.items)),
    sessionQueue: null,
    watchHistory: trimWatchHistory(remote.watchHistory),
    waitingQueue: normalizeWaitingQueue(remote.waitingQueue, remote.defaultRepeat || "all"),
    playbackSource:
      (remote.waitingQueue?.items?.length ?? 0) > 0 ? "waiting" : "playlist",
    ownerUid: owner,
    activeMode: normalizePlaybackModeStored(remote.defaultMode || "music"),
    uiTheme: preferredTheme || normalizeUiThemeStored(remote.uiTheme),
  };
  leaveQueuePlaybackMode();
  delete merged.updatedAt;
  saveState(merged);
}

// ── 채널 구독 (우리 사이트 안에서만. 유튜브 계정 권한과 무관하다) ──────
export function getSubscriptions() {
  return state.subscriptions || [];
}

export function isSubscribed(channelId) {
  if (!channelId) return false;
  return (state.subscriptions || []).some((row) => row.channelId === channelId);
}

export function toggleSubscription(channel) {
  const channelId = channel?.channelId;
  if (!channelId) return false;
  const rows = state.subscriptions || [];
  const on = rows.some((row) => row.channelId === channelId);
  const next = on
    ? rows.filter((row) => row.channelId !== channelId)
    : [
        { channelId, title: channel.title || "채널", art: channel.art || "", addedAt: Date.now() },
        ...rows,
      ].slice(0, 200);
  patchState({ subscriptions: next });
  return !on;
}
