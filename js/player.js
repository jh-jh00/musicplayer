import {
  getState,
  getPlaybackPlaylist,
  getCurrentItem,
  updatePlaybackPlaylist,
  getNowPlayingItem,
  patchState,
  addToWatchHistory,
  isWaitingQueueActive,
  finishWaitingQueueTrack,
  rotateWaitingQueueTrackToEnd,
  prepareWaitingQueuePlayIndex,
  noteTrackPlaybackStarted,
  takePreviousPlayedTrack,
  replaceCurrentQueueTrack,
  suppressBackStackPushOnce,
  hasUpcomingWaitingTracks,
  hasPreviousPlayedTrack,
  shouldUseQueueTransport,
  isQueuePlaybackMode,
  enterQueuePlaybackMode,
  leaveQueuePlaybackMode,
  hasForwardQueuedTrack,
  pushForwardTrack,
  takeForwardTrack,
  hasWaitingQueueItems,
  markQueueTrackIntent,
  getWaitingQueueAsPlaylist,
  commitPlayedTrackToHistory,
  getPlaybackBackStackLength,
  toggleWaitingQueueShuffle,
} from "./playlists.js";
import { canPlayInCurrentVisibility, startBackgroundKeepAlive, stopBackgroundKeepAlive, primeUserGestureAudio, primeForegroundSilentKeepAlive, getBackgroundHiddenForMs, kickBackgroundWatchdogAfterUserResume, maintainBgPauseSession, isSilentKeepAliveActive, isSilentPauseOwnerActive, startSilentAudioKeepAlive, startSilentPrimaryPauseSession, startSilentPauseOwner, stopSilentPauseOwner, stopNativeAudioForPlayback, getPauseOwnerStatus } from "./background-audio.js";
import { debugBg } from "./debug-log.js";

let yt = null;
let ytReady = false;
let playerReady = false;
let playerReadyResolve = null;
let playerReadyPromise = null;
let pendingIndex = null;
let progTimer = null;
let onProgress = null;
let onPlayingChange = null;
let intendedPlaying = false;
let userPaused = false;
let hardPaused = false;
let nudgePauseGen = 0;
let nudgePlaybackGen = 0;
let resumeIfPlayingGen = 0;
let fgResumeTimer = null;
let bgResumeTimer = null;
let fgPauseDeferTimer = null;
let fgPauseDeferGen = 0;
let bgPauseUserTimer = null;
let bgPauseUserGen = 0;
let stablePlayingConfirmGen = 0;
let userResumeRequested = false;
let lastResumeAttemptAt = 0;
let lastUserResumeAt = 0;
let lastPauseAttemptAt = 0;
let lastUserPlayGestureAt = 0;
const BG_PAUSE_GRACE_MS = 2500;
// H-D fix: 백그라운드에서 resume이 아직 landing 못 한 상태를 external-pause로 오판하지 않음
const BG_RESUME_STALL_TIMEOUT_MS = 6000;
const PAUSE_TO_PLAY_GUARD_MS = 800;
/** 앱 전환 직후에만 bg PAUSED → resume 시도 (hiddenForMs 기준, 절대시간 아님)
 * H-M: fix23 로그에서 playerState가 27초+ 동안 PLAYING↔PAUSED↔BUFFERING을 오가며
 * 서서히 안정화되는 패턴이 관찰됨. H-L(재연장 버그) 수정과 별개로, 3초는 iOS가
 * 백그라운드 재생을 안정시키기엔 너무 짧을 수 있음 — 20초로 늘려 재검증. */
const BG_APP_SWITCH_GRACE_MS = 20000;
/** iOS 앱 전환 직후 자동 PAUSED에만 H26 resume (이후는 사용자 pause로 처리) */
const BG_APP_SWITCH_AUTO_RESUME_MS = 5000;
/** bg에서 사용자 resume 직후 YT PAUSED 오동작 무시 (watchdog resume과 분리) */
const BG_POST_RESUME_GRACE_MS = 4000;
/** fix66: real pause wins over Now Playing keepalive hacks. */
const IOS_REAL_PAUSE_STABILITY = true;
/** fix68: iOS user controls win over hidden auto-resume heuristics. */
const IOS_USER_CONTROL_STABILITY = true;
/** fix69: allow one iOS app-switch kick only when playback was just stable. */
const IOS_APP_SWITCH_ONE_SHOT_RESUME = true;
/** fix79: iOS can report PAUSED for several seconds during the first background handoff. */
const IOS_BG_HANDOFF_GRACE_MS = 9000;
let bgPlaybackEstablished = false;
let endLock = false;
let endHandledForVid = "";
let modeSwitchUntil = 0;
let suppressLibraryAdvanceUntil = 0;
/** iOS bg: pause 대신 mute+play 유지 → AV 세션 30초 타임아웃 방지 */
let bgVirtualPaused = false;
let virtualPausePosition = 0;
let savedVolumeBeforeVirtualPause = null;
let virtualPauseSeekTimer = null;
/** fix42/43: bg real pause 중 position 고정 (YT virtual pause 아님) */
let bgPauseHoldPosition = 0;
let deferredBgResume = false;
let fgResumeRecoveryGen = 0;
let lastKnownPlaybackPosition = 0;
let lastKnownPlaybackVid = "";
let lastForegroundAudioSyncAt = 0;
let pendingForegroundUserResume = false;
let hiddenMediaSessionResumeUntil = 0;
let hiddenMediaSessionResumeGen = 0;
let bgAutoSilentPinGen = 0;
let hiddenAppSwitchResumeGen = 0;
let pauseFenceUntil = 0;
let lastStablePlayingAt = 0;
let hiddenAppSwitchPlayingGraceUntil = 0;
const LEGACY_DEFAULT_VOLUME = 70;
const DEFAULT_AUDIBLE_VOLUME = 100;

// #region agent log
function logPlayTransport(trigger, runId = "pre-fix", extra = {}) {
  const wq = getState().waitingQueue;
  const pl = getPlaybackPlaylist();
  const active = getState().playlists.find((p) => p.id === getState().activePlaylistId);
  debugBg("transport", "player.js:logPlayTransport", trigger, {
    runId,
    trigger,
    queueMode: isQueuePlaybackMode(),
    hasQueueItems: hasWaitingQueueItems(),
    hasUpcoming: hasUpcomingWaitingTracks(),
    hasForward: hasForwardQueuedTrack(),
    queueLen: wq?.items?.length ?? 0,
    queueCur: wq?.cur ?? 0,
    playbackSource: getState().playbackSource,
    activePlaylistCur: active?.cur ?? null,
    activePlaylistLen: active?.items?.length ?? null,
    transportPlId: pl?.id ?? null,
    transportPlCur: pl?.cur ?? null,
    transportPlLen: pl?.items?.length ?? null,
    transportVid: getCurrentItem(pl)?.vid ?? null,
    backStackLen: getPlaybackBackStackLength(),
    suppressLibraryAdvanceUntil,
    ...extra,
  });
}
// #endregion

function suppressLibraryAdvance(ms = 8000) {
  suppressLibraryAdvanceUntil = Date.now() + ms;
}

function shouldAllowLibraryAdvance() {
  return Date.now() > suppressLibraryAdvanceUntil;
}

const YT_MOUNT_ID = "ytMount";

let qualityRetryTimers = [];
let musicSaverTimers = [];
let qualityBoostBound = false;
let videoFullscreenGestureBound = false;
let lastLargePlayerView = false;
let lastBoostReloadKey = "";

const MUSIC_SAVER_SIZE = { w: 256, h: 144 };
const IOS_MUSIC_AUDIO_STABLE_SIZE = { w: 640, h: 360 };
const MUSIC_SAVER_QUALITIES = ["tiny", "small", "medium"];

function isMusicMode() {
  return getState().activeMode === "music";
}

function getMusicSaverDimensions() {
  return isIOS() ? IOS_MUSIC_AUDIO_STABLE_SIZE : MUSIC_SAVER_SIZE;
}

function pickLowestPlaybackQuality(levels) {
  if (!levels?.length) return null;
  for (const q of MUSIC_SAVER_QUALITIES) {
    if (levels.includes(q)) return q;
  }
  return levels[levels.length - 1];
}

function clearMusicSaverRetries() {
  musicSaverTimers.forEach(clearTimeout);
  musicSaverTimers = [];
}

function pickStableIosMusicQuality(levels) {
  if (!levels?.length) return null;
  for (const q of ["medium", "large", "hd720", "hd1080", "highres"]) {
    if (levels.includes(q)) return q;
  }
  return null;
}

function applyIosMusicAudioStableMode(force = false) {
  if (!isMusicMode()) return;
  if (!force && Date.now() < modeSwitchUntil) return;
  if (!ytReady || !yt) return;

  const { w, h } = getMusicSaverDimensions();
  let current = null;
  let target = null;
  try {
    yt.setSize(w, h);
  } catch {}

  try {
    const levels = yt.getAvailableQualityLevels?.() || [];
    current = yt.getPlaybackQuality?.();
    target = pickStableIosMusicQuality(levels);
    if (target && (current === "tiny" || current === "small")) {
      yt.setPlaybackQuality(target);
    }
  } catch {}

  // #region agent log
  debugBg("H-85", "player.js:applyIosMusicAudioStableMode", "ios-music-data-saver-bypassed", {
    size: { w, h },
    currentQuality: current,
    targetQuality: target,
    visibility: document.visibilityState,
  });
  // #endregion
}

function applyMusicDataSaver(force = false) {
  if (!isMusicMode()) return;
  if (isIOS()) {
    applyIosMusicAudioStableMode(force);
    return;
  }
  if (!force && Date.now() < modeSwitchUntil) return;
  if (!ytReady || !yt) return;

  const { w, h } = getMusicSaverDimensions();
  try {
    yt.setSize(w, h);
  } catch {}

  try {
    const levels = yt.getAvailableQualityLevels?.() || [];
    const target = pickLowestPlaybackQuality(levels);
    if (!target) return;
    const current = yt.getPlaybackQuality?.();
    if (current !== target) yt.setPlaybackQuality(target);
  } catch {}
}

function scheduleMusicSaverRetries() {
  clearMusicSaverRetries();
  if (!isMusicMode()) return;
  musicSaverTimers = [0, 300, 800, 2000, 4000, 8000].map((ms) =>
    setTimeout(() => applyMusicDataSaver(true), ms)
  );
}

function getPlayerVars() {
  return {
    playsinline: 1,
    rel: 0,
    modestbranding: 1,
    controls: 1,
    enablejsapi: 1,
    fs: 1,
    cc_load_policy: 0,
    iv_load_policy: 3,
    origin: window.location.origin,
  };
}

function getInitialPlayerDimensions() {
  return { w: "100%", h: "100%" };
}

function getBoostReloadKey() {
  const vid = yt?.getVideoData?.()?.video_id || "";
  return `${vid}|large:${isLargePlayerView()}`;
}

function scheduleBoostSizePasses() {
  if (!wantsFixedQuality()) return;
  const delays = isMobileDevice() ? [0, 200, 500, 1000, 2000] : [0, 300, 800];
  delays.forEach((ms) => {
    setTimeout(() => {
      if (!wantsFixedQuality()) return;
      applyPlayerSize();
    }, ms);
  });
}

function maybeReloadOnBoostEnter() {
  if (!wantsFixedQuality() || !isLargePlayerView()) return;
  const key = getBoostReloadKey();
  if (lastBoostReloadKey === key) return;
  lastBoostReloadKey = key;
  scheduleBoostSizePasses();
  setTimeout(() => {
    if (!wantsFixedQuality() || !isLargePlayerView()) return;
    reloadAtCurrentTime();
  }, 500);
}

function getYouTubeEmbedHost() {
  const pref = getState().videoQuality || "auto";
  return pref !== "auto"
    ? "https://www.youtube.com"
    : "https://www.youtube-nocookie.com";
}

function loadVideoByIdAt(vid, startSeconds) {
  if (!yt) return;
  try {
    if (startSeconds != null) yt.loadVideoById(vid, startSeconds);
    else yt.loadVideoById(vid);
  } catch {}
}

function getCurrentYtPosition() {
  if (!ytReady || !yt?.getCurrentTime) return 0;
  try {
    return yt.getCurrentTime?.() || 0;
  } catch {
    return 0;
  }
}

function getCurrentYtVid() {
  if (!ytReady || !yt?.getVideoData) return "";
  try {
    return yt.getVideoData?.()?.video_id || "";
  } catch {
    return "";
  }
}

function rememberPlaybackPosition(cur = null) {
  const pos = cur ?? getCurrentYtPosition();
  const item = getNowPlayingItem();
  const vid = getCurrentYtVid() || item?.vid || "";
  if (!vid || pos <= 0.2) return;
  if (item?.vid && vid !== item.vid) return;
  lastKnownPlaybackVid = vid;
  lastKnownPlaybackPosition = pos;
}

function getBestResumePosition(item = getNowPlayingItem()) {
  const currentPos = getCurrentYtPosition();
  const knownMatches = !lastKnownPlaybackVid || lastKnownPlaybackVid === item?.vid;
  const knownPos = knownMatches ? lastKnownPlaybackPosition : 0;
  return Math.max(bgPauseHoldPosition || 0, currentPos || 0, knownPos || 0);
}

function hasNativeAudioRouteConflict() {
  return isIOS() && (isSilentPauseOwnerActive() || isSilentKeepAliveActive());
}

function isHiddenMediaSessionResumePending() {
  return isIOS() && document.visibilityState !== "visible" && Date.now() < hiddenMediaSessionResumeUntil;
}

function cancelHiddenAppSwitchResume(reason, extra = {}) {
  hiddenAppSwitchResumeGen += 1;
  // #region agent log
  debugBg("H-65", "player.js:cancelHiddenAppSwitchResume", "hidden-app-switch-resume-cancelled", {
    reason,
    ...extra,
  });
  // #endregion
}

function clearHiddenAppSwitchPlayingGrace(reason, extra = {}) {
  if (!hiddenAppSwitchPlayingGraceUntil) return;
  // #region agent log
  debugBg("H-76", "player.js:clearHiddenAppSwitchPlayingGrace", "hidden-app-switch-grace-cleared", {
    reason,
    remainingMs: hiddenAppSwitchPlayingGraceUntil - Date.now(),
    ...extra,
  });
  // #endregion
  hiddenAppSwitchPlayingGraceUntil = 0;
}

function clearHiddenMediaSessionResume(reason, extra = {}) {
  if (!hiddenMediaSessionResumeUntil) return;
  // #region agent log
  debugBg("H-55", "player.js:clearHiddenMediaSessionResume", "hidden-ms-resume-cleared", {
    reason,
    remainingMs: hiddenMediaSessionResumeUntil - Date.now(),
    ...extra,
  });
  // #endregion
  hiddenMediaSessionResumeUntil = 0;
}

function pinHiddenSilentPauseSession(reason) {
  if (IOS_REAL_PAUSE_STABILITY) {
    // #region agent log
    debugBg("H-67", "player.js:pinHiddenSilentPauseSession", "silent-pin-disabled", {
      reason,
      visibility: document.visibilityState,
    });
    // #endregion
    return false;
  }
  if (!isIOS() || document.visibilityState === "visible" || userPaused || hardPaused) return false;
  const item = getNowPlayingItem();
  if (!item?.vid) return false;
  try {
    bgPauseHoldPosition = getBestResumePosition(item);
  } catch {
    bgPauseHoldPosition = 0;
  }
  userResumeRequested = false;
  pendingForegroundUserResume = false;
  deferredBgResume = false;
  bgPlaybackEstablished = false;
  intendedPlaying = false;
  userPaused = true;
  hardPaused = true;
  markPauseAttempt();
  cancelNudgePause();
  cancelNudgePlayback();
  cancelStablePlayingConfirm();
  clearPendingResumes();
  stopBgVirtualPause();
  if (isIOS()) stopNativeAudioForPlayback();
  setPlaying(false);
  startBackgroundKeepAlive({ pauseSession: true });
  void startSilentPrimaryPauseSession().then(() => setPlaying(false));
  maintainBgPauseSession();
  // #region agent log
  debugBg("H-55", "player.js:pinHiddenSilentPauseSession", "auto-bg-silent-pin", {
    reason,
    bgPauseHoldPosition,
    lastKnownPlaybackPosition,
    visibility: document.visibilityState,
  });
  // #endregion
  return true;
}

function scheduleHiddenAutoSilentPin(reason, delayMs = 1200) {
  if (!isIOS() || document.visibilityState === "visible" || userPaused || hardPaused || !intendedPlaying) return;
  const gen = bgAutoSilentPinGen;
  const startPos = getCurrentYtPosition();
  let startState = null;
  try {
    startState = ytReady && yt ? yt.getPlayerState() : null;
  } catch {}
  setTimeout(() => {
    if (
      gen !== bgAutoSilentPinGen ||
      document.visibilityState === "visible" ||
      userPaused ||
      hardPaused ||
      !intendedPlaying ||
      !ytReady ||
      !yt
    ) {
      return;
    }
    let st = null;
    try {
      st = yt.getPlayerState();
    } catch {}
    const endPos = getCurrentYtPosition();
    const advanced = endPos - startPos;
    const shouldPin = st !== window.YT.PlayerState.PLAYING;
    // #region agent log
    debugBg("H-55", "player.js:scheduleHiddenAutoSilentPin", shouldPin ? "auto-pin-check-hit" : "auto-pin-check-skip", {
      reason,
      startState,
      st,
      startPos,
      endPos,
      advanced,
      delayMs,
      trustHiddenPlaying: st === window.YT.PlayerState.PLAYING,
    });
    // #endregion
    if (shouldPin) pinHiddenSilentPauseSession(reason);
  }, delayMs);
}

function scheduleHiddenPlayingMediaSessionRefresh(reason) {
  if (!isIOS() || document.visibilityState === "visible" || userPaused || hardPaused || !intendedPlaying) return;
  [0, 250, 750, 1500, 3000, 5000, 8000].forEach((ms, attempt) => {
    setTimeout(() => {
      if (!isIOS() || document.visibilityState === "visible" || userPaused || hardPaused || !intendedPlaying) return;
      let st = null;
      try {
        st = ytReady && yt ? yt.getPlayerState() : null;
      } catch {}
      if (IOS_USER_CONTROL_STABILITY && IOS_REAL_PAUSE_STABILITY && st !== window.YT?.PlayerState?.PLAYING) {
        // #region agent log
        debugBg("H-68", "player.js:scheduleHiddenPlayingMediaSessionRefresh", "hidden-ms-refresh-skipped-not-playing", {
          reason,
          attempt,
          ms,
          st,
          visibility: document.visibilityState,
        });
        // #endregion
        return;
      }
      setPlaying(true);
      startBackgroundKeepAlive();
      // #region agent log
      debugBg("H-59", "player.js:scheduleHiddenPlayingMediaSessionRefresh", "hidden-playing-ms-refreshed", {
        reason,
        attempt,
        ms,
        visibility: document.visibilityState,
        st,
      });
      // #endregion
    }, ms);
  });
}

function pinHiddenAppSwitchPlayingGrace(reason, durationMs = IOS_BG_HANDOFF_GRACE_MS, extra = {}) {
  if (!isIOS() || document.visibilityState === "visible" || userPaused || hardPaused || !intendedPlaying) return;
  hiddenAppSwitchPlayingGraceUntil = Math.max(hiddenAppSwitchPlayingGraceUntil, Date.now() + durationMs);
  // #region agent log
  debugBg("H-76", "player.js:pinHiddenAppSwitchPlayingGrace", "hidden-app-switch-grace-pinned", {
    reason,
    durationMs,
    hiddenForMs: getBackgroundHiddenForMs(),
    untilInMs: hiddenAppSwitchPlayingGraceUntil - Date.now(),
    ...extra,
  });
  // #endregion
}

function isHiddenAppSwitchPlayingGraceActive() {
  return (
    isIOS() &&
    document.visibilityState !== "visible" &&
    intendedPlaying &&
    !userPaused &&
    !hardPaused &&
    Date.now() < hiddenAppSwitchPlayingGraceUntil &&
    getBackgroundHiddenForMs() <= IOS_BG_HANDOFF_GRACE_MS
  );
}

function keepHiddenAppSwitchMediaSessionPlaying(reason, extra = {}) {
  bgPlaybackEstablished = true;
  rememberPlaybackPosition();
  setPlaying(true);
  startProgress();
  startBackgroundKeepAlive();
  // #region agent log
  debugBg("H-76", "player.js:keepHiddenAppSwitchMediaSessionPlaying", "hidden-paused-race-kept-playing-once", {
    reason,
    hiddenForMs: getBackgroundHiddenForMs(),
    graceRemainingMs: hiddenAppSwitchPlayingGraceUntil - Date.now(),
    ...extra,
  });
  // #endregion
}

function markStablePlaying() {
  lastStablePlayingAt = Date.now();
}

function shouldUseOneShotHiddenAppSwitchResume() {
  if (!IOS_APP_SWITCH_ONE_SHOT_RESUME || !IOS_USER_CONTROL_STABILITY || !IOS_REAL_PAUSE_STABILITY) return false;
  if (!isIOS() || document.visibilityState === "visible" || userPaused || hardPaused || !intendedPlaying) return false;
  if (!ytReady || !yt) return false;
  const hiddenForMs = getBackgroundHiddenForMs();
  const sinceStableMs = Date.now() - lastStablePlayingAt;
  if (hiddenForMs > 1200) return false;
  if (lastStablePlayingAt <= lastPauseAttemptAt) return false;
  return sinceStableMs >= 0 && sinceStableMs < 3500;
}

function scheduleOneShotHiddenAppSwitchResume(reason) {
  if (!shouldUseOneShotHiddenAppSwitchResume()) return false;
  const gen = ++hiddenAppSwitchResumeGen;
  const delayMs = 180;
  setTimeout(() => {
    if (
      gen !== hiddenAppSwitchResumeGen ||
      document.visibilityState === "visible" ||
      userPaused ||
      hardPaused ||
      !intendedPlaying ||
      !ytReady ||
      !yt ||
      !shouldUseOneShotHiddenAppSwitchResume()
    ) {
      return;
    }
    let st = null;
    try {
      st = yt.getPlayerState();
    } catch {}
    const hiddenForMs = getBackgroundHiddenForMs();
    if (st === window.YT.PlayerState.PLAYING) {
      bgPlaybackEstablished = true;
      markStablePlaying();
      rememberPlaybackPosition();
      setPlaying(true);
      startProgress();
      startBackgroundKeepAlive();
      // #region agent log
      debugBg("H-69", "player.js:scheduleOneShotHiddenAppSwitchResume", "hidden-one-shot-already-playing", {
        reason,
        st,
        hiddenForMs,
      });
      // #endregion
      return;
    }
    if (
      st === window.YT.PlayerState.PAUSED ||
      st === window.YT.PlayerState.BUFFERING ||
      st === window.YT.PlayerState.CUED ||
      st === window.YT.PlayerState.UNSTARTED
    ) {
      markResumeAttempt();
      try {
        yt.unMute?.();
        ensurePlayerVolume({ reason: "hidden-one-shot" });
        yt.playVideo?.();
      } catch {}
      startBackgroundKeepAlive();
      // #region agent log
      debugBg("H-69", "player.js:scheduleOneShotHiddenAppSwitchResume", "hidden-one-shot-playVideo-called", {
        reason,
        st,
        hiddenForMs,
        sinceStableMs: Date.now() - lastStablePlayingAt,
      });
      // #endregion
    }
  }, delayMs);
  // #region agent log
  debugBg("H-69", "player.js:scheduleOneShotHiddenAppSwitchResume", "hidden-one-shot-queued", {
    reason,
    delayMs,
    hiddenForMs: getBackgroundHiddenForMs(),
    sinceStableMs: Date.now() - lastStablePlayingAt,
  });
  // #endregion
  return true;
}

function scheduleHiddenAppSwitchResume(reason) {
  if (!isIOS() || document.visibilityState === "visible" || userPaused || hardPaused || !intendedPlaying || !ytReady || !yt) {
    return false;
  }
  if (IOS_USER_CONTROL_STABILITY && IOS_REAL_PAUSE_STABILITY) {
    const queued = scheduleOneShotHiddenAppSwitchResume(reason);
    if (queued) return true;
    let st = null;
    try {
      st = yt.getPlayerState();
    } catch {}
    // #region agent log
    debugBg("H-68", "player.js:scheduleHiddenAppSwitchResume", "hidden-auto-resume-disabled", {
      reason,
      st,
      hiddenForMs: getBackgroundHiddenForMs(),
      intendedPlaying,
      userPaused,
      hardPaused,
    });
    // #endregion
    return false;
  }
  const gen = ++hiddenAppSwitchResumeGen;
  const delays = [0, 120, 280, 500, 850, 1300, 2000, 3200, 4500];
  delays.forEach((ms, attempt) => {
    setTimeout(() => {
      if (
        gen !== hiddenAppSwitchResumeGen ||
        document.visibilityState === "visible" ||
        userPaused ||
        hardPaused ||
        !intendedPlaying ||
        !ytReady ||
        !yt
      ) {
        return;
      }
      const hiddenForMs = getBackgroundHiddenForMs();
      if (hiddenForMs > BG_APP_SWITCH_AUTO_RESUME_MS + 750) return;
      let st = null;
      try {
        st = yt.getPlayerState();
      } catch {}
      if (st === window.YT.PlayerState.PLAYING) {
        bgPlaybackEstablished = true;
        rememberPlaybackPosition();
        setPlaying(true);
        startProgress();
        startBackgroundKeepAlive();
        ensurePlayerVolume();
        // #region agent log
        debugBg("H-61", "player.js:scheduleHiddenAppSwitchResume", "hidden-app-switch-playing", {
          reason,
          attempt,
          ms,
          hiddenForMs,
          st,
        });
        // #endregion
        return;
      }
      if (
        st === window.YT.PlayerState.PAUSED ||
        st === window.YT.PlayerState.BUFFERING ||
        st === window.YT.PlayerState.CUED ||
        st === window.YT.PlayerState.UNSTARTED
      ) {
        if (hasNativeAudioRouteConflict()) stopNativeAudioForPlayback();
        markResumeAttempt();
        try {
          yt.playVideo();
        } catch {}
        setPlaying(true);
        startBackgroundKeepAlive();
        ensurePlayerVolume();
        // #region agent log
        debugBg("H-61", "player.js:scheduleHiddenAppSwitchResume", "hidden-app-switch-playVideo-called", {
          reason,
          attempt,
          ms,
          hiddenForMs,
          st,
        });
        // #endregion
      }
    }, ms);
  });
  return true;
}

function clearResumeHoldPosition(reason, extra = {}) {
  if (bgPauseHoldPosition <= 0 && !deferredBgResume) return;
  // #region agent log
  debugBg("H-51", "player.js:clearResumeHoldPosition", "resume-position-latch-cleared", {
    reason,
    bgPauseHoldPosition,
    deferredBgResume,
    ...extra,
  });
  // #endregion
  bgPauseHoldPosition = 0;
  deferredBgResume = false;
  pendingForegroundUserResume = false;
  hiddenMediaSessionResumeUntil = 0;
}

function cancelStablePlayingConfirm() {
  stablePlayingConfirmGen += 1;
}

function confirmStablePlaying(reason, extra = {}, onConfirmed = null) {
  if (!isIOS() || document.visibilityState !== "visible") return false;
  const gen = ++stablePlayingConfirmGen;
  const startPos = getCurrentYtPosition();
  const startState = (() => {
    try {
      return yt?.getPlayerState?.() ?? null;
    } catch {
      return null;
    }
  })();
  setPlaying(false);
  // #region agent log
  debugBg("H-54", "player.js:confirmStablePlaying", "stable-check-start", {
    reason,
    startPos,
    startState,
    bgPauseHoldPosition,
    ...extra,
  });
  // #endregion
  setTimeout(() => {
    if (gen !== stablePlayingConfirmGen || !ytReady || !yt || !intendedPlaying || userPaused || hardPaused) {
      // #region agent log
      debugBg("H-54", "player.js:confirmStablePlaying", "stable-check-cancelled", {
        reason,
        gen,
        currentGen: stablePlayingConfirmGen,
        intendedPlaying,
        userPaused,
        hardPaused,
      });
      // #endregion
      return;
    }
    let state = null;
    try {
      state = yt.getPlayerState();
    } catch {}
    const endPos = getCurrentYtPosition();
    const advanced = endPos - startPos;
    const routeConflict = hasNativeAudioRouteConflict();
    const ok = state === window.YT.PlayerState.PLAYING && advanced >= 0.35 && !routeConflict;
    // #region agent log
    debugBg("H-54", "player.js:confirmStablePlaying", ok ? "stable-check-ok" : "stable-check-fail", {
      reason,
      state,
      startPos,
      endPos,
      advanced,
      routeConflict,
      ownerActive: isSilentPauseOwnerActive(),
      silentActive: isSilentKeepAliveActive(),
      ...extra,
    });
    // #endregion
    if (!ok) {
      setPlaying(false);
      if (routeConflict) stopNativeAudioForPlayback();
      return;
    }
    markStablePlaying();
    rememberPlaybackPosition(endPos);
    onConfirmed?.({ state, startPos, endPos, advanced });
  }, 1200);
  return true;
}

function recoverForegroundResume(reason, initialState = null) {
  if (!isIOS() || document.visibilityState !== "visible" || !ytReady || !yt) return false;
  const item = getNowPlayingItem();
  if (!item?.vid) return false;
  const gen = ++fgResumeRecoveryGen;
  bgAutoSilentPinGen += 1;
  const currentPos = getCurrentYtPosition();
  const knownPos = lastKnownPlaybackVid === item.vid ? lastKnownPlaybackPosition : 0;
  const pos = getBestResumePosition(item);

  stopNativeAudioForPlayback();
  cancelNudgePause();
  cancelNudgePlayback();
  cancelStablePlayingConfirm();
  clearHiddenMediaSessionResume("foreground-recovery", { reason });
  primeUserGestureAudio();
  intendedPlaying = true;
  userPaused = false;
  hardPaused = false;
  deferredBgResume = false;
  pendingForegroundUserResume = false;
  userResumeRequested = true;
  pauseFenceUntil = 0;
  markUserResume();
  setPlaying(false);

  // #region agent log
  debugBg("H-51", "player.js:recoverForegroundResume", "fg-resume-recovery-start", {
    reason,
    initialState,
    pos,
    bgPauseHoldPosition,
    currentPos,
    knownPos,
    fix: "fix79",
  });
  if (pos <= 0.5) {
    debugBg("H-51", "player.js:recoverForegroundResume", "fg-resume-pos-zero", {
      reason,
      bgPauseHoldPosition,
      currentPos,
      knownPos,
    });
  }
  // #endregion

  try {
    yt.unMute?.();
    ensurePlayerVolume({ reason: "hidden-ms-resume-setup" });
  } catch {}

  loadVideoByIdAt(item.vid, pos > 0.5 ? pos : undefined);
  const kickPlayback = (attempt) => {
    if (gen !== fgResumeRecoveryGen || !ytReady || !yt) return;
    try {
      yt.playVideo();
    } catch {}
    ensurePlayerVolume();
    if (isMobileDevice()) restoreVolumeAfterMutedAutoplay(isIOS() ? 20 : 10);
    nudgePlayback(isMobileDevice() ? 12 : 6);
    if (attempt === 0) setTimeout(() => kickPlayback(1), 500);
  };
  setTimeout(() => kickPlayback(0), 150);
  startBackgroundKeepAlive();
  return true;
}

/** fix70/71: paused state stops silent keepalive and primes hidden next-track MediaSession. */
function resumeAfterUserPause(st, source) {
  if (!IOS_REAL_PAUSE_STABILITY && isIOS() && document.visibilityState !== "visible") {
    deferredBgResume = false;
    pendingForegroundUserResume = true;
    userResumeRequested = true;
    lastUserPlayGestureAt = Date.now();
    intendedPlaying = false;
    userPaused = true;
    hardPaused = true;
    setPlaying(false);
    // #region agent log
    debugBg("H-52", "player.js:resumeAfterUserPause", "bg-resume-needs-foreground-tap", {
      source,
      st,
      bgPauseHoldPosition,
      fix: "fix79",
      ...getPauseOwnerStatus(),
    });
    // #endregion
    return false;
  }
  if (isIOS() && document.visibilityState === "visible") {
    pendingForegroundUserResume = false;
    recoverForegroundResume(source, st);
    return true;
  }
  resumeFromUserPause(st);
  return true;
}

export function resumeFromMediaSessionControl(source = "media-session") {
  if (!canPlayInCurrentVisibility()) return false;
  const item = getNowPlayingItem();
  if (!item?.vid || !ytReady || !playerReady || !yt) return false;
  if (!isIOS() || document.visibilityState === "visible") {
    return resumeByUser();
  }

  let st = null;
  try {
    st = yt.getPlayerState();
  } catch {}
  if (!userPaused && !hardPaused && st === window.YT?.PlayerState?.PLAYING) {
    return resumeByUser();
  }
  const pos = getBestResumePosition(item);
  const gen = ++hiddenMediaSessionResumeGen;
  bgAutoSilentPinGen += 1;
  hiddenMediaSessionResumeUntil = Date.now() + 16000;
  userResumeRequested = true;
  pendingForegroundUserResume = false;
  deferredBgResume = false;
  intendedPlaying = true;
  userPaused = false;
  hardPaused = false;
  bgPlaybackEstablished = false;
  pauseFenceUntil = 0;
  markUserResume();
  cancelNudgePause();
  cancelNudgePlayback();
  cancelStablePlayingConfirm();
  stopBgVirtualPause();
  stopNativeAudioForPlayback();
  primeUserGestureAudio();
  setPlaying(false);

  // #region agent log
  debugBg("H-55", "player.js:resumeFromMediaSessionControl", "hidden-ms-resume-request", {
    source,
    st,
    pos,
    bgPauseHoldPosition,
    lastKnownPlaybackPosition,
    visibility: document.visibilityState,
  });
  // #endregion

  try {
    yt.unMute?.();
    ensurePlayerVolume({ reason: "hidden-ms-resume-setup" });
  } catch {}

  const attemptPlay = (attempt = 0) => {
    if (gen !== hiddenMediaSessionResumeGen || !ytReady || !yt || document.visibilityState === "visible") return;
    try {
      yt.unMute?.();
      ensurePlayerVolume({ reason: "hidden-ms-resume-attempt" });
      yt.playVideo?.();
    } catch (err) {
      // #region agent log
      debugBg("H-55", "player.js:resumeFromMediaSessionControl", "hidden-ms-play-fail", {
        source,
        attempt,
        err: String(err?.message || err),
      });
      // #endregion
    }
    // #region agent log
    debugBg("H-55", "player.js:resumeFromMediaSessionControl", "hidden-ms-play-attempt", {
      source,
      attempt,
      pos,
      routeConflict: hasNativeAudioRouteConflict(),
    });
    // #endregion
    ensurePlayerVolume();
    const maxAttempts = isIOS() ? 0 : 10;
    if (attempt < maxAttempts) setTimeout(() => attemptPlay(attempt + 1), 450);
  };

  try {
    const currentVid = getCurrentYtVid();
    if (currentVid && currentVid !== item.vid) {
      loadVideoByIdAt(item.vid, pos > 0.5 ? pos : undefined);
      setTimeout(() => attemptPlay(0), 120);
    } else {
      if (pos > 0.5) {
        try {
          yt.seekTo?.(pos, true);
        } catch {}
      }
      if (st === window.YT.PlayerState.UNSTARTED || st === window.YT.PlayerState.CUED) {
        loadVideoByIdAt(item.vid, pos > 0.5 ? pos : undefined);
        setTimeout(() => attemptPlay(0), 120);
      } else {
        attemptPlay(0);
      }
    }
  } catch {
    attemptPlay(0);
  }

  startBackgroundKeepAlive();
  kickBackgroundWatchdogAfterUserResume();
  return true;
}

function cueVideoByIdPlain(vid) {
  if (!yt) return;
  try {
    yt.cueVideoById(vid);
  } catch {}
}

function clampPlayerVolume(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return DEFAULT_AUDIBLE_VOLUME;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function getTargetPlayerVolume() {
  const state = getState();
  if (state.volumeTouched) return clampPlayerVolume(state.volume);
  if (isIOS() && (state.volume == null || state.volume === LEGACY_DEFAULT_VOLUME)) {
    return DEFAULT_AUDIBLE_VOLUME;
  }
  return clampPlayerVolume(state.volume ?? DEFAULT_AUDIBLE_VOLUME);
}

function ensurePlayerVolume({ force = false, reason = "ensure" } = {}) {
  try {
    if (yt?.isMuted?.()) yt.unMute();
    const state = getState();
    const targetVolume = getTargetPlayerVolume();
    const hiddenIos = isIOS() && document.visibilityState !== "visible";
    if (hiddenIos && !force) {
      // #region agent log
      debugBg("H-79", "player.js:ensurePlayerVolume", "hidden-ios-volume-preserved", {
        reason,
        targetVolume,
        storedVolume: state.volume,
        volumeTouched: Boolean(state.volumeTouched),
        currentVolume: yt?.getVolume?.(),
        visibility: document.visibilityState,
      });
      // #endregion
      return;
    }
    if (isIOS() && !state.volumeTouched && state.volume === LEGACY_DEFAULT_VOLUME && targetVolume === DEFAULT_AUDIBLE_VOLUME) {
      // #region agent log
      debugBg("H-84", "player.js:ensurePlayerVolume", "ios-legacy-default-volume-lifted", {
        reason,
        storedVolume: state.volume,
        targetVolume,
        visibility: document.visibilityState,
      });
      // #endregion
    }
    yt.setVolume(targetVolume);
  } catch {}
}

function shouldUseMutedMobileKickoff() {
  return isMobileDevice() && !isIOS();
}

function nudgePlayback(tries = 6, intervalMs = 200) {
  if (!ytReady || !yt || !intendedPlaying || userPaused || hardPaused) return;
  const gen = ++nudgePlaybackGen;
  const YT = window.YT.PlayerState;
  const tick = (left) => {
    if (gen !== nudgePlaybackGen || !ytReady || !yt || !intendedPlaying || userPaused || hardPaused || left <= 0) return;
    try {
      const st = yt.getPlayerState();
      if (st === YT.PLAYING) {
        if (hasNativeAudioRouteConflict()) {
          // #region agent log
          debugBg("H-51", "player.js:nudgePlayback", "route-conflict-before-playing-confirm", {
            visibility: document.visibilityState,
            ownerActive: isSilentPauseOwnerActive(),
            silentActive: isSilentKeepAliveActive(),
          });
          // #endregion
          stopNativeAudioForPlayback();
          setPlaying(false);
          if (document.visibilityState === "visible") {
            recoverForegroundResume("nudge-route-conflict", st);
          }
          return;
        }
        if (confirmStablePlaying("nudge-playing", { st }, () => {
          ensurePlayerVolume();
          rememberPlaybackPosition();
          clearResumeHoldPosition("nudge-confirmed-stable", { st });
          setPlaying(true);
          startProgress();
        })) {
          return;
        }
        ensurePlayerVolume();
        rememberPlaybackPosition();
        clearResumeHoldPosition("nudge-confirmed-playing", { st });
        setPlaying(true);
        startProgress();
        return;
      }
      if (st === YT.CUED || st === YT.PAUSED || st === YT.UNSTARTED || st === YT.BUFFERING) {
        yt.playVideo();
      }
    } catch {}
    setTimeout(() => tick(left - 1), intervalMs);
  };
  tick(tries);
}

function cancelNudgePause() {
  nudgePauseGen += 1;
}

function cancelNudgePlayback() {
  nudgePlaybackGen += 1;
}

function markResumeAttempt() {
  lastResumeAttemptAt = Date.now();
}

function markUserResume() {
  lastUserResumeAt = Date.now();
  markResumeAttempt();
}

function markPauseAttempt() {
  lastPauseAttemptAt = Date.now();
}

function shouldAllowAutoResume() {
  if (hardPaused || userPaused || !intendedPlaying) {
    // #region agent log
    debugBg("H22", "player.js:shouldAllowAutoResume", "blocked-flags", {
      hardPaused,
      userPaused,
      intendedPlaying,
    });
    // #endregion
    return false;
  }
  if (lastResumeAttemptAt <= lastPauseAttemptAt && Date.now() - lastPauseAttemptAt < 2500) {
    // #region agent log
    debugBg("H22", "player.js:shouldAllowAutoResume", "blocked-pause-grace", {
      sincePauseMs: Date.now() - lastPauseAttemptAt,
    });
    // #endregion
    return false;
  }
  return true;
}

function cancelResumeAttempts() {
  resumeIfPlayingGen += 1;
}

function cancelFgPauseDefer() {
  fgPauseDeferGen += 1;
  clearTimeout(fgPauseDeferTimer);
  fgPauseDeferTimer = null;
}

function cancelBgUserPauseDetect() {
  bgPauseUserGen += 1;
  clearTimeout(bgPauseUserTimer);
  bgPauseUserTimer = null;
}

function scheduleFgUserPauseDetect(delayMs = 500) {
  const gen = ++fgPauseDeferGen;
  clearTimeout(fgPauseDeferTimer);
  fgPauseDeferTimer = setTimeout(() => {
    fgPauseDeferTimer = null;
    if (gen !== fgPauseDeferGen || userPaused || hardPaused) return;
    if (document.visibilityState !== "visible") return;
    let st = null;
    try {
      st = yt?.getPlayerState();
    } catch {}
    if (st !== window.YT.PlayerState.PAUSED) return;
    // #region agent log
    debugBg("H25", "player.js:scheduleFgUserPauseDetect", "user-pause-detected", {
      visibility: document.visibilityState,
    });
    // #endregion
    pauseByUser();
  }, delayMs);
}

function scheduleBgUserPauseDetect() {
  const gen = ++bgPauseUserGen;
  clearTimeout(bgPauseUserTimer);
  bgPauseUserTimer = setTimeout(() => {
    bgPauseUserTimer = null;
    if (gen !== bgPauseUserGen || userPaused || hardPaused) return;
    if (document.visibilityState === "visible") return;
    let st = null;
    try {
      st = yt?.getPlayerState();
    } catch {}
    if (st !== window.YT.PlayerState.PAUSED) return;
    if (lastUserResumeAt > lastPauseAttemptAt && Date.now() - lastUserResumeAt < BG_POST_RESUME_GRACE_MS) {
      return;
    }
    // #region agent log
    debugBg("H25", "player.js:scheduleBgUserPauseDetect", "bg-user-pause-detected", {
      hiddenForMs: getBackgroundHiddenForMs(),
    });
    // #endregion
    pauseByUser();
  }, 1500);
}

function clearPendingResumes() {
  clearTimeout(fgResumeTimer);
  clearTimeout(bgResumeTimer);
  fgResumeTimer = null;
  bgResumeTimer = null;
  cancelNudgePlayback();
  cancelResumeAttempts();
  cancelFgPauseDefer();
  cancelBgUserPauseDetect();
  if (userPaused || hardPaused || !intendedPlaying) clearHiddenAppSwitchPlayingGrace("clear-pending-resumes");
}

function scheduleForegroundResume() {
  clearTimeout(fgResumeTimer);
  fgResumeTimer = setTimeout(() => {
    fgResumeTimer = null;
    // #region agent log
    debugBg("H23", "player.js:scheduleForegroundResume", "timer-fired", {
      hardPaused,
      userPaused,
      intendedPlaying,
      willResume: shouldAllowAutoResume(),
    });
    // #endregion
    if (shouldAllowAutoResume()) resumeIfPlaying();
  }, 400);
}

function nudgePause(tries = 8, intervalMs = 200) {
  if (bgVirtualPaused) return;
  if (!ytReady || !yt || (!userPaused && !hardPaused)) return;
  markPauseAttempt();
  const gen = ++nudgePauseGen;
  const YT = window.YT.PlayerState;
  // #region agent log
  debugBg("H8", "player.js:nudgePause", "start", {
    tries,
    visibility: document.visibilityState,
    ytState: (() => {
      try {
        return yt.getPlayerState();
      } catch {
        return null;
      }
    })(),
  });
  // #endregion
  const tick = (left) => {
    if (gen !== nudgePauseGen || !ytReady || !yt || (!userPaused && !hardPaused) || left <= 0) {
      if (gen === nudgePauseGen && left <= 0 && (userPaused || hardPaused)) {
        let st = null;
        try {
          st = yt?.getPlayerState();
        } catch {}
        // #region agent log
        debugBg("H8", "player.js:nudgePause", "exhausted-still-not-paused", {
          ytState: st,
          visibility: document.visibilityState,
        });
        // #endregion
      }
      return;
    }
    try {
      const st = yt.getPlayerState();
      if (st === YT.PAUSED) {
        // #region agent log
        debugBg("H8", "player.js:nudgePause", "confirmed-paused", {
          retriesLeft: left,
          visibility: document.visibilityState,
        });
        // #endregion
        return;
      }
      yt.pauseVideo();
    } catch {}
    setTimeout(() => tick(left - 1), intervalMs);
  };
  try {
    yt.pauseVideo();
  } catch {}
  tick(tries);
}

function restoreVolumeAfterMutedAutoplay(maxAttempts = 15) {
  const attempt = (left = maxAttempts) => {
    if (!intendedPlaying || !yt) return;
    try {
      if (yt.getPlayerState() === window.YT.PlayerState.PLAYING) {
        ensurePlayerVolume();
        return;
      }
    } catch {}
    if (left > 0) setTimeout(() => attempt(left - 1), 150);
  };
  attempt();
}

function startMediaPlayback(vid, startSeconds) {
  if (!canPlayInCurrentVisibility()) return;
  if (!yt) return;
  intendedPlaying = true;
  userPaused = false;
  hardPaused = false;
  pendingForegroundUserResume = false;
  primeUserGestureAudio();
  if (isIOS()) stopNativeAudioForPlayback();
  startBackgroundKeepAlive();

  const mobile = isMobileDevice();
  const mutedKickoff = shouldUseMutedMobileKickoff();
  if (mutedKickoff) {
    try {
      yt.mute();
    } catch {}
  } else {
    ensurePlayerVolume();
  }

  // #region agent log
  debugBg("H-77", "player.js:startMediaPlayback", "audible-kickoff-policy", {
    ios: isIOS(),
    mobile,
    mutedKickoff,
    visibility: document.visibilityState,
    activeMode: getState().activeMode,
  });
  // #endregion

  loadVideoByIdAt(vid, startSeconds);
  try {
    yt.playVideo();
  } catch {}

  if (document.visibilityState !== "visible") {
    setPlaying(true);
    startProgress();
    // #region agent log
    debugBg("H-70", "player.js:startMediaPlayback", "hidden-autoplay-mediasession-primed", {
      vid,
      startSeconds,
      activeMode: getState().activeMode,
    });
    // #endregion
  }

  nudgePlayback(mobile ? 14 : 6);

  if (!isIOS()) {
    // #region agent log
    debugBg("H-53", "player.js:startMediaPlayback", "desktop-native-silent-audio-skipped", {
      visibility: document.visibilityState,
    });
    // #endregion
  }
  if (mutedKickoff) restoreVolumeAfterMutedAutoplay();
  else ensurePlayerVolume();

  if (isMusicMode()) scheduleMusicSaverRetries();
}

function isPausedAtStart() {
  if (!ytReady || !yt?.getCurrentTime) return false;
  try {
    return (yt.getCurrentTime() || 0) < 1.5;
  } catch {
    return false;
  }
}

/** iOS virtual pause: vol 0 → iOS가 non-media로 판단(H-Z). 최소 1 유지 */
const VIRTUAL_PAUSE_VOLUME_IOS = 1;

function getVirtualPauseVolume() {
  return isIOS() ? VIRTUAL_PAUSE_VOLUME_IOS : 0;
}
/** fix44: seek drift 허용(>5s) — 2초 seek loop 제거 */
const VIRTUAL_PAUSE_SEEK_DRIFT_S = 5;

function shouldUseBgVirtualPause() {
  // fix45: virtual pause 전면 OFF — pause 중 어떤 소리도 금지 (Codex 지원 요청 중)
  return false;
}

function enforceVirtualPauseSoft() {
  if (!bgVirtualPaused || !ytReady || !yt) return;
  try {
    const YT = window.YT.PlayerState;
    if (yt.getPlayerState() === YT.PAUSED) yt.playVideo();
    yt.setVolume(getVirtualPauseVolume());
    const cur = yt.getCurrentTime();
    if (Math.abs(cur - virtualPausePosition) > VIRTUAL_PAUSE_SEEK_DRIFT_S) {
      yt.seekTo(virtualPausePosition, true);
    }
  } catch {}
}

function enforceVirtualPausePosition() {
  enforceVirtualPauseSoft();
}

function startBgVirtualPause() {
  if (!shouldUseBgVirtualPause() || !ytReady || !yt) return false;
  try {
    virtualPausePosition = yt.getCurrentTime();
    savedVolumeBeforeVirtualPause = yt.getVolume?.() ?? getTargetPlayerVolume();
    bgVirtualPaused = true;
    yt.unMute?.();
    yt.setVolume(getVirtualPauseVolume());
    const YT = window.YT.PlayerState;
    if (yt.getPlayerState() !== YT.PLAYING) yt.playVideo();
    clearInterval(virtualPauseSeekTimer);
    virtualPauseSeekTimer = setInterval(enforceVirtualPauseSoft, 15000);
    // #region agent log
    debugBg("H-S", "player.js:startBgVirtualPause", "virtual-pause-started", {
      virtualPausePosition,
      savedVolume: savedVolumeBeforeVirtualPause,
      pauseVolume: getVirtualPauseVolume(),
      seekDriftS: VIRTUAL_PAUSE_SEEK_DRIFT_S,
    });
    debugBg("H-44", "player.js:startBgVirtualPause", "virtual-pause-no-loop", {
      pauseVolume: getVirtualPauseVolume(),
      seekIntervalMs: 15000,
    });
    // #endregion
    return true;
  } catch {
    bgVirtualPaused = false;
    return false;
  }
}

function stopBgVirtualPause() {
  if (!bgVirtualPaused) return;
  bgVirtualPaused = false;
  clearInterval(virtualPauseSeekTimer);
  virtualPauseSeekTimer = null;
  try {
    if (savedVolumeBeforeVirtualPause != null) yt?.setVolume?.(savedVolumeBeforeVirtualPause);
    else ensurePlayerVolume();
    yt?.unMute?.();
    if (virtualPausePosition > 0) yt?.seekTo?.(virtualPausePosition, true);
  } catch {}
  savedVolumeBeforeVirtualPause = null;
  // #region agent log
  debugBg("H-S", "player.js:stopBgVirtualPause", "virtual-pause-stopped", {
    virtualPausePosition,
  });
  // #endregion
}

/** iOS bg virtual pause 후 volume 0/mute 잔류 복구 */
function restoreAudioAfterVirtualPause() {
  const wasVirtual = bgVirtualPaused;
  const targetVol = savedVolumeBeforeVirtualPause ?? getTargetPlayerVolume();
  stopBgVirtualPause();
  if (!ytReady || !yt) return;
  primeUserGestureAudio();
  try {
    yt.unMute?.();
    yt.setVolume?.(targetVol);
  } catch {}
  ensurePlayerVolume();
  let vol = null;
  let muted = null;
  try {
    vol = yt.getVolume?.();
    muted = yt.isMuted?.();
    const YT = window.YT.PlayerState;
    const st = yt.getPlayerState();
    if (vol < 1 || muted || wasVirtual) {
      yt.unMute?.();
      yt.setVolume?.(targetVol);
      if (wasVirtual && st === YT.PLAYING) {
        yt.pauseVideo();
        setTimeout(() => {
          try {
            yt.unMute?.();
            yt.setVolume?.(targetVol);
            yt.playVideo();
          } catch {}
        }, 80);
      } else if (st !== YT.PLAYING) {
        yt.playVideo();
      }
    }
  } catch {}
  if (isMobileDevice()) restoreVolumeAfterMutedAutoplay(isIOS() ? 30 : 15);
  // #region agent log
  debugBg("H-T", "player.js:restoreAudioAfterVirtualPause", "audio-restored", {
    wasVirtual,
    targetVol,
    vol,
    muted,
    visibility: document.visibilityState,
  });
  // #endregion
}

/** bg pause: silent primary only — virtual pause 금지 */
export function ensureBgPauseAvSession() {
  if (document.visibilityState === "visible" || (!userPaused && !hardPaused)) return;
  if (IOS_REAL_PAUSE_STABILITY) {
    stopNativeAudioForPlayback();
    // #region agent log
    debugBg("H-66", "player.js:ensureBgPauseAvSession", "bg-pause-keepalive-disabled", {
      visibility: document.visibilityState,
      userPaused,
      hardPaused,
    });
    // #endregion
    return;
  }
  if (bgVirtualPaused) stopBgVirtualPause();
  if (isIOS()) void startSilentPrimaryPauseSession().then(() => setPlaying(false));
}

export function getBgPauseHoldPosition() {
  if (document.visibilityState === "visible") return null;
  if (!userPaused && !hardPaused) return null;
  return bgPauseHoldPosition > 0 ? bgPauseHoldPosition : null;
}

export function getBgVirtualPausePosition() {
  return bgVirtualPaused ? virtualPausePosition : null;
}

function isIOS() {
  return (
    /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isMobileDevice() {
  return (
    isIOS() ||
    /Android/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 0 && window.matchMedia?.("(pointer: coarse)")?.matches)
  );
}

export function isCoarsePointerDevice() {
  return isMobileDevice();
}

function isLargePlayerView() {
  return isYtFullscreen();
}

function getQualityPreference() {
  return getState().videoQuality || "auto";
}

function wantsFixedQuality() {
  return getState().activeMode === "video" && getQualityPreference() !== "auto";
}

function getEmbeddedPlayerSize() {
  const stage = document.getElementById("videoStage");
  const rect = stage?.getBoundingClientRect();
  const w = rect?.width > 0 ? rect.width : 480;
  const h = rect?.height > 0 ? rect.height : (w * 9) / 16;
  return { w: Math.round(w), h: Math.round(h) };
}

function fitAspect16x9(w, h) {
  const aspect = 16 / 9;
  if (w / h > aspect) return { w: Math.round(h * aspect), h: Math.round(h) };
  return { w: Math.round(w), h: Math.round(w / aspect) };
}

function getStagePixelSize() {
  const stage = document.getElementById("videoStage");
  const rect = stage?.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  let w = rect?.width > 0 ? rect.width : 480;
  let h = rect?.height > 0 ? rect.height : (w * 9) / 16;
  return fitAspect16x9(Math.round(w * dpr), Math.round(h * dpr));
}

function getViewportPixelSize() {
  const dpr = window.devicePixelRatio || 1;
  const vw = window.visualViewport?.width || window.innerWidth;
  const vh = window.visualViewport?.height || window.innerHeight;
  const stage = getStagePixelSize();
  const w = Math.round(Math.max(stage.w, vw * dpr));
  const h = Math.round(Math.max(stage.h, vh * dpr));
  return fitAspect16x9(w, h);
}

function getQualityTargetSize() {
  if (!wantsFixedQuality()) return getEmbeddedPlayerSize();
  if (isLargePlayerView()) return getViewportPixelSize();
  return getStagePixelSize();
}

function isYtFullscreen() {
  const fs = document.fullscreenElement || document.webkitFullscreenElement;
  const mount = document.getElementById(YT_MOUNT_ID);
  const stage = document.getElementById("videoStage");
  const iframe = mount?.querySelector("iframe");

  if (fs) {
    return Boolean(
      (stage && (fs === stage || stage.contains(fs) || fs.contains(stage))) ||
        (mount && (fs === mount || mount.contains(fs) || fs.contains(mount))) ||
        (iframe && (fs === iframe || fs.contains(iframe)))
    );
  }

  if (!iframe) return false;
  const r = iframe.getBoundingClientRect();
  const vw = window.visualViewport?.width || window.innerWidth;
  const vh = window.visualViewport?.height || window.innerHeight;
  if (vw <= 0 || vh <= 0) return false;

  const widthRatio = r.width / vw;
  const heightRatio = r.height / vh;
  const areaRatio = (r.width * r.height) / (vw * vh);

  if (widthRatio >= 0.9 && heightRatio >= 0.5) return true;
  if (areaRatio >= 0.55) return true;

  if (isIOS()) {
    if (widthRatio >= 0.97 && heightRatio >= 0.32) return true;
    if (heightRatio >= 0.68) return true;
    const stage = document.getElementById("videoStage");
    const sr = stage?.getBoundingClientRect();
    if (sr) {
      const stageArea = (sr.width * sr.height) / (vw * vh);
      if (stageArea >= 0.48 && widthRatio >= 0.92) return true;
    }
    if (wantsFixedQuality() && vw > vh && widthRatio >= 0.9 && intendedPlaying) {
      return true;
    }
  }

  return false;
}

function applyPlayerSize() {
  if (!ytReady || !yt?.setSize || getState().activeMode !== "video") return;

  const size = getQualityTargetSize();

  try {
    yt.setSize(size.w, size.h);
  } catch {}
}

function clearQualityRetries() {
  qualityRetryTimers.forEach(clearTimeout);
  qualityRetryTimers = [];
}

function reloadAtCurrentTime() {
  if (!ytReady || !yt) return;
  let vid = "";
  let time = 0;
  let wasPlaying = false;
  try {
    vid = yt.getVideoData?.()?.video_id || "";
    time = yt.getCurrentTime() || 0;
    const st = yt.getPlayerState();
    wasPlaying =
      intendedPlaying ||
      st === window.YT.PlayerState.PLAYING ||
      st === window.YT.PlayerState.BUFFERING;
  } catch {
    return;
  }
  if (!vid) return;

  if (wasPlaying) {
    startMediaPlayback(vid, time);
    setTimeout(() => applyVideoQuality(true), 500);
  } else {
    loadVideoByIdAt(vid, time);
    setTimeout(() => applyVideoQuality(true), 500);
  }
}

function scheduleQualityRetries(preference) {
  clearQualityRetries();
  if (preference === "auto") return;
  if (!isLargePlayerView() && !isMobileDevice()) return;

  const delays = isMobileDevice() ? [200, 600, 1200, 2500, 4000] : [400, 1000, 2000, 3500];
  qualityRetryTimers = delays.map((ms) =>
    setTimeout(() => {
      if (getState().activeMode !== "video") return;
      if (getQualityPreference() !== preference) return;
      applyPlayerSize();
    }, ms)
  );
}

function handlePlayerLayoutChange() {
  const large = isLargePlayerView();
  const wasLarge = lastLargePlayerView;
  lastLargePlayerView = large;

  applyPlayerSize();

  if (!wantsFixedQuality()) return;

  scheduleQualityRetries(getQualityPreference());

  if (large) {
    if (!wasLarge) maybeReloadOnBoostEnter();
    else scheduleBoostSizePasses();
  } else {
    if (wasLarge) lastBoostReloadKey = "";
    if (isMobileDevice()) scheduleBoostSizePasses();
    else clearQualityRetries();
  }
}

function handlePlaybackQualityChange() {
  if (isMusicMode()) {
    applyMusicDataSaver(true);
    return;
  }
  if (!wantsFixedQuality()) return;
  applyPlayerSize();
}

function getYtIframe() {
  return document.getElementById(YT_MOUNT_ID)?.querySelector("iframe") || null;
}

function ensureVideoFullscreenCapability() {
  const stage = document.getElementById("videoStage");
  const iframe = getYtIframe();

  if (stage) {
    stage.classList.add("video-fullscreen-ready");
    stage.setAttribute("tabindex", "0");
    stage.setAttribute("aria-label", "영상 전체 화면");
  }

  if (!iframe) return;

  const allow = new Set(
    (iframe.getAttribute("allow") || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
  );
  ["autoplay", "encrypted-media", "fullscreen", "picture-in-picture"].forEach((part) =>
    allow.add(part)
  );

  iframe.setAttribute("allow", Array.from(allow).join("; "));
  iframe.setAttribute("allowfullscreen", "");
  iframe.setAttribute("webkitallowfullscreen", "");
}

async function requestVideoFullscreenFromStage() {
  if (getState().activeMode !== "video") return;

  const stage = document.getElementById("videoStage");
  const iframe = getYtIframe();
  if (!stage) return;

  ensureVideoFullscreenCapability();

  const activeFullscreen = document.fullscreenElement || document.webkitFullscreenElement;
  if (activeFullscreen) return;

  try {
    if (stage.requestFullscreen) {
      await stage.requestFullscreen({ navigationUI: "hide" });
      return;
    }
  } catch {}

  try {
    if (stage.webkitRequestFullscreen) {
      stage.webkitRequestFullscreen();
      return;
    }
  } catch {}

  try {
    if (iframe?.webkitEnterFullscreen) iframe.webkitEnterFullscreen();
  } catch {}
}

function bindVideoFullscreenGesture() {
  if (videoFullscreenGestureBound) return;
  const stage = document.getElementById("videoStage");
  if (!stage) return;

  videoFullscreenGestureBound = true;
  ensureVideoFullscreenCapability();

  let lastTap = 0;

  stage.addEventListener("dblclick", (e) => {
    if (getState().activeMode !== "video") return;
    e.preventDefault();
    void requestVideoFullscreenFromStage();
  });

  stage.addEventListener(
    "click",
    (e) => {
      if (!isMobileDevice() || getState().activeMode !== "video") return;
      const now = Date.now();
      if (now - lastTap < 340) {
        e.preventDefault();
        void requestVideoFullscreenFromStage();
      }
      lastTap = now;
    },
    { passive: false }
  );

  stage.addEventListener("keydown", (e) => {
    if (getState().activeMode !== "video") return;
    if (e.key !== "Enter" && e.key?.toLowerCase() !== "f") return;
    e.preventDefault();
    void requestVideoFullscreenFromStage();
  });
}

function observeMobileIframeResize() {
  if (!isMobileDevice()) return;
  const iframe = document.getElementById(YT_MOUNT_ID)?.querySelector("iframe");
  ensureVideoFullscreenCapability();
  if (!iframe || iframe.dataset.qualityObserved || typeof ResizeObserver === "undefined") return;
  iframe.dataset.qualityObserved = "1";
  new ResizeObserver(() => {
    if (!wantsFixedQuality() || getState().activeMode !== "video") return;
    handlePlayerLayoutChange();
  }).observe(iframe);
}

function bindQualityBoost() {
  if (qualityBoostBound) return;
  qualityBoostBound = true;

  const onLayoutChange = () => {
    if (getState().activeMode !== "video") return;
    handlePlayerLayoutChange();
  };

  document.addEventListener("fullscreenchange", onLayoutChange);
  document.addEventListener("webkitfullscreenchange", onLayoutChange);
  window.visualViewport?.addEventListener("resize", onLayoutChange);
  window.addEventListener("orientationchange", () => {
    [300, 800].forEach((ms) => setTimeout(onLayoutChange, ms));
  });

  const stage = document.getElementById("videoStage");
  if (stage && typeof ResizeObserver !== "undefined") {
    new ResizeObserver(onLayoutChange).observe(stage);
  }
}

function applyVideoQuality(force = false) {
  if (!force && Date.now() < modeSwitchUntil) return;
  if (getState().activeMode !== "video") return;
  applyPlayerSize();
  if (wantsFixedQuality()) {
    scheduleQualityRetries(getQualityPreference());
  } else {
    clearQualityRetries();
  }
}

export function refreshVideoPlayerLayout() {
  if (getState().activeMode !== "video") return;
  getMount("video");
  requestAnimationFrame(() => {
    applyVideoQuality(true);
  });
}

export function setVideoQuality(val) {
  const prev = getQualityPreference();
  patchState({ videoQuality: val });

  const hostChanged = (prev === "auto") !== (val === "auto");

  if (hostChanged && yt) {
    void rebuildPlayerForQuality();
    return;
  }

  lastLargePlayerView = false;
  applyPlayerSize();
  applyVideoQuality(true);
  if (val !== "auto" && isLargePlayerView()) {
    scheduleQualityRetries(val);
    maybeReloadOnBoostEnter();
  }
}

async function rebuildPlayerForQuality() {
  if (!yt || !ytReady) return;

  let vid = "";
  let time = 0;
  let wasPlaying = false;
  try {
    vid = yt.getVideoData?.()?.video_id || "";
    time = yt.getCurrentTime() || 0;
    wasPlaying =
      intendedPlaying ||
      yt.getPlayerState() === window.YT.PlayerState.PLAYING ||
      yt.getPlayerState() === window.YT.PlayerState.BUFFERING;
  } catch {
    return;
  }

  try {
    yt.destroy();
  } catch {}
  yt = null;
  playerReady = false;
  playerReadyPromise = null;
  lastBoostReloadKey = "";
  lastLargePlayerView = false;

  if (!vid) {
    await ensurePlayer("");
    return;
  }

  await ensurePlayer(vid);
  if (!ytReady || !playerReady || !yt) return;

  if (wasPlaying) loadVideoByIdAt(vid, time);
  else cueVideoByIdPlain(vid);

  applyPlayerSize();
  applyVideoQuality(true);
}

export function initPlayerShell() {
  getMount(getState().activeMode);
  bindQualityBoost();
  bindVideoFullscreenGesture();
  preloadYouTubeApi();
  void warmPlayer();
}

export function preloadYouTubeApi() {
  void loadApi();
}

export async function warmPlayer(vid) {
  const id = vid || getCurrentItem(getPlaybackPlaylist())?.vid;
  if (!id) return;
  await ensurePlayer(id);
  if (!ytReady || !playerReady || !yt) return;
  try {
    const st = yt.getPlayerState();
    const current = yt.getVideoData?.()?.video_id;
    if (current === id && st !== window.YT.PlayerState.UNSTARTED) return;
    cueVideoByIdPlain(id);
  } catch {}
}

export function setProgressHandler(fn) {
  onProgress = fn;
}

// 영상이 끝났는데 이어서 재생할 게 없을 때 부른다. 시청 페이지가 자체 종료 화면을 띄운다.
let trackEndHandler = null;
export function setTrackEndHandler(fn) {
  trackEndHandler = fn;
}

function notifyTrackEnd() {
  try {
    trackEndHandler?.();
  } catch {}
}

export function setPlayingChangeHandler(fn) {
  onPlayingChange = fn;
}

function loadApi() {
  if (window.YT?.Player) {
    ytReady = true;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (!document.querySelector("script[data-yt-api]")) {
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      s.dataset.ytApi = "1";
      s.onerror = () => reject(new Error("YouTube API 로드 실패"));
      document.head.appendChild(s);
    }
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prev === "function") prev();
      ytReady = true;
      resolve();
    };
  });
}

function beginPlayerInit() {
  playerReady = false;
  playerReadyPromise = new Promise((resolve) => {
    playerReadyResolve = resolve;
  });
}

function finishPlayerInit() {
  playerReady = true;
  playerReadyResolve?.();
  playerReadyResolve = null;
}

async function waitPlayerReady() {
  if (playerReady && yt) return;
  if (playerReadyPromise) await playerReadyPromise;
}

function getMount(mode) {
  const mount = document.getElementById(YT_MOUNT_ID);
  const stage = document.getElementById("videoStage");
  if (!mount) return null;
  const m = mode ?? getState().activeMode;

  if (m === "music") {
    const { w, h } = getMusicSaverDimensions();
    mount.style.setProperty("--player-w", `${w}px`);
    mount.style.setProperty("--player-h", `${h}px`);
  } else if (stage) {
    const r = stage.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      mount.style.setProperty("--player-w", `${Math.round(r.width)}px`);
      mount.style.setProperty("--player-h", `${Math.round(r.height)}px`);
    } else {
      const app = document.querySelector(".app");
      const w = app ? Math.min(app.clientWidth || window.innerWidth, 480) : window.innerWidth;
      mount.style.setProperty("--player-w", `${Math.round(w)}px`);
      mount.style.setProperty("--player-h", `${Math.round((w * 9) / 16)}px`);
    }
  }

  mount.classList.toggle("music-mode", m === "music");
  mount.classList.toggle("video-mode", m === "video");
  if (m === "video") applyPlayerSize();
  else if (m === "music") applyMusicDataSaver();
  return mount;
}

function restorePlayback(time, wasPlaying) {
  if (!yt || !ytReady || !wasPlaying || userPaused || hardPaused) return;

  intendedPlaying = true;
  const gen = resumeIfPlayingGen;
  const YT = window.YT.PlayerState;

  try {
    const st = yt.getPlayerState();
    const cur = yt.getCurrentTime() || 0;

    if (st === YT.PLAYING && Math.abs(cur - time) < 0.6) {
      startProgress();
      return;
    }

    if (time > 0.3 && Math.abs(cur - time) > 0.35) {
      yt.seekTo(time, true);
    }

    if (st !== YT.PLAYING && st !== YT.BUFFERING) {
      yt.playVideo();
    }
    startProgress();

    const nudge = (left = 4) => {
      if (gen !== resumeIfPlayingGen || !intendedPlaying || userPaused || hardPaused || left <= 0) return;
      try {
        const s = yt.getPlayerState();
        if (s === YT.PLAYING) return;
        if (s === YT.PAUSED || s === YT.BUFFERING || s === YT.CUED) yt.playVideo();
      } catch {}
      setTimeout(() => nudge(left - 1), 120);
    };
    setTimeout(() => nudge(), 80);
  } catch {}
}

async function ensurePlayer(vid) {
  await loadApi();
  const mode = getState().activeMode;
  const mount = getMount(mode);
  if (!mount) return;

  if (yt) {
    await waitPlayerReady();
    ensurePlayerVolume({ reason: "ensure-existing-player" });
    if (isMusicMode()) applyMusicDataSaver();
    return;
  }

  beginPlayerInit();
  const dims = getInitialPlayerDimensions();
  yt = new window.YT.Player(YT_MOUNT_ID, {
    host: getYouTubeEmbedHost(),
    videoId: vid || "",
    width: dims.w,
    height: dims.h,
    playerVars: getPlayerVars(),
    events: {
      onReady: () => {
        finishPlayerInit();
        try {
          ensurePlayerVolume({ reason: "player-ready" });
          if (isMusicMode()) {
            applyMusicDataSaver(true);
            scheduleMusicSaverRetries();
          } else {
            applyVideoQuality();
          }
          observeMobileIframeResize();
        } catch {}
        if (pendingIndex != null) {
          const i = pendingIndex;
          pendingIndex = null;
          playIndex(i, true);
        }
      },
      onStateChange: handleStateChange,
      onPlaybackQualityChange: (e) => handlePlaybackQualityChange(e.data),
      onError: () => playNext(true),
    },
  });
  await waitPlayerReady();
}

function shouldAdvanceTrack() {
  if (!ytReady || !yt?.getDuration || !yt?.getPlayerState) return false;
  try {
    const dur = yt.getDuration() || 0;
    if (dur < 1) return false;
    const cur = yt.getCurrentTime() || 0;
    const st = yt.getPlayerState();
    const YT = window.YT.PlayerState;
    if (st === YT.ENDED) return true;
    if (cur < dur - 0.75) return false;
    if (st === YT.PLAYING) return true;
    if (st === YT.PAUSED || st === YT.BUFFERING) return cur >= dur - 0.25;
    return false;
  } catch {
    return false;
  }
}

function onTrackEnded() {
  const pl = getPlaybackPlaylist();
  if (!pl || endLock) return;
  const vid = getCurrentItem(pl)?.vid || "";
  if (vid && endHandledForVid === vid) return;

  endLock = true;
  endHandledForVid = vid;
  setTimeout(() => {
    endLock = false;
  }, 2000);

  if (pl.repeat === "one") {
    try {
      intendedPlaying = true;
      yt.seekTo(0, true);
      yt.playVideo();
      nudgePlayback(isMobileDevice() ? 8 : 4);
      endHandledForVid = "";
    } catch {}
    return;
  }
  if (isWaitingQueueActive()) {
    // 여기서 endHandledForVid 를 비우면, 같은 영상의 종료 신호가 한 번 더 들어왔을 때
    // 다시 처리된다. 그때는 대기열이 이미 비어 있어 보관함 목록으로 넘어가 버린다.
    // 다음 곡으로 넘어가면 vid 자체가 달라지므로 비울 필요가 없다.
    // #region agent log
    logPlayTransport("onTrackEnded-queue");
    // #endregion
    advanceWaitingQueue(true, { fromEnd: true });
    return;
  }
  if (!shouldAllowLibraryAdvance()) {
    // #region agent log
    logPlayTransport("onTrackEnded-suppressed-library");
    // #endregion
    intendedPlaying = false;
    setPlaying(false);
    notifyTrackEnd();
    return;
  }
  if (pl.repeat === "all" || pl.cur < pl.items.length - 1) {
    endHandledForVid = "";
    // #region agent log
    logPlayTransport("onTrackEnded-library-fallback");
    // #endregion
    playNext(true);
    return;
  }
  intendedPlaying = false;
  setPlaying(false);
  notifyTrackEnd();
}

function handleStateChange(e) {
  if (!canPlayInCurrentVisibility()) {
    if (e.data === window.YT.PlayerState.PLAYING || e.data === window.YT.PlayerState.BUFFERING) pauseForBackground();
    return;
  }
  const pl = getPlaybackPlaylist();
  if (!pl) return;
  if (e.data === window.YT.PlayerState.ENDED) {
    onTrackEnded();
  } else if (e.data === window.YT.PlayerState.PLAYING) {
    cancelFgPauseDefer();
    cancelBgUserPauseDetect();
    bgAutoSilentPinGen += 1;
    let resumedFromUserPause = false;
    if (hardPaused || userPaused) {
      const userGestureResume =
        userResumeRequested || lastUserPlayGestureAt > lastPauseAttemptAt;
      if (bgVirtualPaused && !userGestureResume) {
        // #region agent log
        debugBg("H-S", "player.js:PLAYING", "virtual-pause-maintain", {
          sincePauseMs: Date.now() - lastPauseAttemptAt,
        });
        // #endregion
        enforceVirtualPausePosition();
        return;
      }
      const sincePauseMs = Date.now() - lastPauseAttemptAt;
      const autoResumeSincePause = lastResumeAttemptAt > lastPauseAttemptAt;
      const allowImplicitExternalResume =
        !isIOS() && sincePauseMs >= PAUSE_TO_PLAY_GUARD_MS && !autoResumeSincePause;
      const blockedByPauseFence =
        isIOS() && !userGestureResume && Date.now() < pauseFenceUntil;
      if (blockedByPauseFence || (!userGestureResume && !allowImplicitExternalResume)) {
        // #region agent log
        debugBg("H-65", "player.js:PLAYING", "blocked-implicit-playing-while-paused", {
          hardPaused,
          userPaused,
          sincePauseMs,
          autoResumeSincePause,
          userResumeRequested,
          pauseFenceRemainingMs: pauseFenceUntil - Date.now(),
          visibility: document.visibilityState,
        });
        // #endregion
        nudgePause();
        return;
      }
      if (userGestureResume || allowImplicitExternalResume) {
        // #region agent log
        debugBg("H27", "player.js:PLAYING", "external-user-resume-accepted", {
          sincePauseMs,
          autoResumeSincePause,
          userResumeRequested,
          visibility: document.visibilityState,
        });
        // #endregion
        resumedFromUserPause = true;
        userResumeRequested = false;
        pauseFenceUntil = 0;
        cancelNudgePause();
        hardPaused = false;
        userPaused = false;
        markUserResume();
      } else {
        // #region agent log
        debugBg("H24", "player.js:PLAYING", "blocked-while-paused", {
          hardPaused,
          userPaused,
          sincePauseMs,
          autoResumeSincePause,
          visibility: document.visibilityState,
        });
        // #endregion
        nudgePause();
        return;
      }
    }
    if (hasNativeAudioRouteConflict()) {
      // #region agent log
      debugBg("H-51", "player.js:PLAYING", "route-conflict-before-playing-confirm", {
        visibility: document.visibilityState,
        ownerActive: isSilentPauseOwnerActive(),
        silentActive: isSilentKeepAliveActive(),
        resumedFromUserPause,
      });
      // #endregion
      stopNativeAudioForPlayback();
      setPlaying(false);
      if (document.visibilityState === "visible") {
        recoverForegroundResume("state-playing-route-conflict", e.data);
      }
      return;
    }
    if (isHiddenMediaSessionResumePending()) {
      bgPlaybackEstablished = true;
      markStablePlaying();
      rememberPlaybackPosition();
      ensurePlayerVolume();
      setPlaying(true);
      startProgress();
      startBackgroundKeepAlive();
      // #region agent log
      debugBg("H-63", "player.js:PLAYING", "hidden-ms-playing-confirmed", {
        visibility: document.visibilityState,
        holdPos: bgPauseHoldPosition,
        lastKnownPlaybackPosition,
        remainingMs: hiddenMediaSessionResumeUntil - Date.now(),
      });
      // #endregion
      return;
    }
    intendedPlaying = true;
    const commitPlaying = (stable = {}) => {
      markStablePlaying();
      rememberPlaybackPosition(stable.endPos);
      clearResumeHoldPosition("state-playing-confirmed", { resumedFromUserPause, stable });
      setPlaying(true);
      if (document.visibilityState !== "visible") {
        bgPlaybackEstablished = true;
      }
      startProgress();
      startBackgroundKeepAlive();
      if (document.visibilityState === "visible") {
        primeForegroundSilentKeepAlive();
      }
      if (resumedFromUserPause) {
        restoreAudioAfterVirtualPause();
        if (document.visibilityState !== "visible") kickBackgroundWatchdogAfterUserResume();
      } else {
        ensurePlayerVolume();
        if (isMobileDevice()) restoreVolumeAfterMutedAutoplay();
      }
      if (isMusicMode()) {
        applyMusicDataSaver(true);
        scheduleMusicSaverRetries();
      } else {
        applyVideoQuality();
        handlePlayerLayoutChange();
      }
      if (wantsFixedQuality()) {
        scheduleBoostSizePasses();
        [400, 1200].forEach((ms) => setTimeout(() => handlePlayerLayoutChange(), ms));
      }
      let actualVid = "";
      try {
        actualVid = yt.getVideoData()?.video_id || "";
      } catch {}
      const currentPl = getPlaybackPlaylist();
      const item = getCurrentItem(currentPl);
      if (!item?.vid) return;
      if (actualVid && actualVid !== item.vid) return;
      addToWatchHistory(item);
      noteTrackPlaybackStarted(item);
    };
    if (confirmStablePlaying("state-playing", { resumedFromUserPause }, commitPlaying)) return;
    commitPlaying();
  } else if (
    e.data === window.YT.PlayerState.CUED ||
    e.data === window.YT.PlayerState.UNSTARTED
  ) {
    if (intendedPlaying) nudgePlayback(isMobileDevice() ? 10 : 4);
  } else if (e.data === window.YT.PlayerState.PAUSED) {
    if (bgVirtualPaused) {
      enforceVirtualPausePosition();
      return;
    }
    if (shouldAdvanceTrack()) {
      onTrackEnded();
      return;
    }
    if (intendedPlaying && isPausedAtStart()) {
      const resumePos = getBestResumePosition(getNowPlayingItem());
      if (isIOS() && document.visibilityState === "visible" && resumePos > 0.5) {
        // #region agent log
        debugBg("H-51", "player.js:PAUSED", "paused-at-start-with-latch-recover", {
          visibility: document.visibilityState,
          intendedPlaying,
          resumePos,
          bgPauseHoldPosition,
          lastKnownPlaybackPosition,
        });
        // #endregion
        recoverForegroundResume("paused-at-start-with-latch", e.data);
        return;
      }
      // #region agent log
      debugBg("H1", "player.js:PAUSED", "branch-nudge-at-start", {
        visibility: document.visibilityState,
        intendedPlaying,
      });
      // #endregion
      nudgePlayback(isMobileDevice() ? 10 : 4);
      return;
    }
    if (Date.now() < modeSwitchUntil && intendedPlaying) return;

    if (userPaused || hardPaused) {
      // #region agent log
      debugBg("H7", "player.js:PAUSED", "branch-user-paused", {
        visibility: document.visibilityState,
        intendedPlaying,
        userPaused,
        hardPaused,
      });
      // #endregion
      hardPaused = true;
      intendedPlaying = false;
      setPlaying(false);
      if (document.visibilityState === "visible") {
        stopBackgroundKeepAlive();
      } else if (IOS_REAL_PAUSE_STABILITY && isIOS()) {
        stopNativeAudioForPlayback();
        stopBackgroundKeepAlive();
        // #region agent log
        debugBg("H-67", "player.js:PAUSED", "paused-hidden-keepalive-stopped", {
          visibility: document.visibilityState,
          userPaused,
          hardPaused,
        });
        // #endregion
      } else {
        maintainBgPauseSession();
      }
      return;
    }

    if (document.visibilityState !== "visible") {
      const hiddenForMs = getBackgroundHiddenForMs();
      // #region agent log
      debugBg("H13", "player.js:PAUSED", "branch-bg-paused", {
        hiddenForMs,
        visibility: document.visibilityState,
        intendedPlaying,
        userPaused,
      });
      // #endregion
      if (IOS_USER_CONTROL_STABILITY && IOS_REAL_PAUSE_STABILITY && isIOS() && intendedPlaying && !userPaused && !hardPaused) {
        if (isHiddenAppSwitchPlayingGraceActive()) {
          keepHiddenAppSwitchMediaSessionPlaying("hidden-paused-app-switch-grace", { hiddenForMs });
          scheduleHiddenPlayingMediaSessionRefresh("hidden-paused-app-switch-grace");
          return;
        }
        setPlaying(false);
        bgPlaybackEstablished = false;
        // #region agent log
        debugBg("H-68", "player.js:PAUSED", "hidden-paused-inference-disabled", {
          hiddenForMs,
          bgPlaybackEstablished,
          intendedPlaying,
          userPaused,
          hardPaused,
        });
        // #endregion
        return;
      }
      if (isIOS() && intendedPlaying && !userPaused && !hardPaused && !bgPlaybackEstablished) {
        scheduleHiddenAppSwitchResume("hidden-paused-state");
      }
      if (intendedPlaying && !userPaused && !hardPaused) {
        if (bgPlaybackEstablished) {
          const sinceUserResumeMs = Date.now() - lastUserResumeAt;
          const inPostUserResumeGrace =
            lastUserResumeAt > lastPauseAttemptAt && sinceUserResumeMs < BG_POST_RESUME_GRACE_MS;
          if (inPostUserResumeGrace) {
            // #region agent log
            debugBg("H-P", "player.js:PAUSED", "bg-pause-skipped-post-user-resume", {
              hiddenForMs,
              sinceUserResumeMs,
            });
            // #endregion
            return;
          }
          userResumeRequested = false;
          if (hiddenForMs >= BG_APP_SWITCH_AUTO_RESUME_MS) {
            // #region agent log
            debugBg("H-U", "player.js:PAUSED", "bg-user-pause-immediate", { hiddenForMs });
            // #endregion
            pauseByUser();
            return;
          }
          // #region agent log
          debugBg("H-N", "player.js:PAUSED", "bg-user-pause-after-established", {
            hiddenForMs,
          });
          // #endregion
          scheduleBgUserPauseDetect();
          return;
        }
        if (hiddenForMs < BG_APP_SWITCH_AUTO_RESUME_MS && shouldAllowAutoResume()) {
          cancelBgUserPauseDetect();
          startBackgroundKeepAlive();
          // #region agent log
          debugBg("H26", "player.js:PAUSED", "branch-bg-app-switch-resume", {
            hiddenForMs,
            graceMs: BG_APP_SWITCH_AUTO_RESUME_MS,
            resumeGen: resumeIfPlayingGen,
          });
          // #endregion
          resumeIfPlaying();
        }
      }
      return;
    }

    // #region agent log
    debugBg("H7", "player.js:PAUSED", "branch-fg-pause-clear", {
      visibility: document.visibilityState,
      intendedPlaying,
      userPaused,
      hardPaused,
    });
    // #endregion
    if (intendedPlaying && !userPaused && !hardPaused) {
      if (isIOS()) {
        setPlaying(false);
        scheduleFgUserPauseDetect(1200);
        // #region agent log
        debugBg("H-68", "player.js:PAUSED", "fg-transient-pause-not-resumed", {
          visibility: document.visibilityState,
          intendedPlaying,
          playerState: e.data,
        });
        // #endregion
      } else {
        setPlaying(false);
        scheduleFgUserPauseDetect();
      }
    }
    return;
  }
}

function setPlaying(on) {
  onPlayingChange?.(on);
}

function startProgress() {
  clearInterval(progTimer);
  progTimer = setInterval(() => {
    if (!ytReady || !yt?.getDuration) return;
    const cur = yt.getCurrentTime();
    const dur = yt.getDuration();
    rememberPlaybackPosition(cur);
    onProgress?.(cur, dur);

    if (dur >= 1) {
      let vid = "";
      try {
        vid = yt.getVideoData?.()?.video_id || "";
      } catch {}
      if (vid && vid !== endHandledForVid && cur < dur - 2) {
        endHandledForVid = "";
      }
      if (shouldAdvanceTrack()) {
        onTrackEnded();
      }
    }
  }, 250);
}

function nextIndex(pl, delta) {
  if (!pl.items.length) return 0;
  if (pl.shuffle && pl.shuffleOrder?.length === pl.items.length) {
    const pos = pl.shuffleOrder.indexOf(pl.cur);
    const nextPos = (pos + delta + pl.shuffleOrder.length) % pl.shuffleOrder.length;
    return pl.shuffleOrder[nextPos];
  }
  return (pl.cur + delta + pl.items.length) % pl.items.length;
}

export async function playIndex(index, autoplay = false, options = {}) {
  if (!canPlayInCurrentVisibility()) return;
  const visibilityGeneration = playbackVisibilityGeneration;
  const pl = getPlaybackPlaylist();
  if (!pl?.items?.length) return;
  const prevItem = getCurrentItem(pl);
  let idx = ((index % pl.items.length) + pl.items.length) % pl.items.length;
  if (isWaitingQueueActive() && !options.skipQueuePrepare) {
    idx = prepareWaitingQueuePlayIndex(idx);
  } else if (shouldUseQueueTransport() && !options.skipQueuePrepare) {
    enterQueuePlaybackMode();
    idx = prepareWaitingQueuePlayIndex(idx);
  } else if (shouldUseQueueTransport()) {
    enterQueuePlaybackMode();
  }
  const transportPl = getPlaybackPlaylist();
  const nextItem = transportPl?.items[idx] ?? pl.items[idx];
  if (prevItem?.vid && nextItem?.vid && prevItem.vid !== nextItem.vid) {
    commitPlayedTrackToHistory(prevItem);
  }
  updatePlaybackPlaylist((p) => ({ ...p, cur: idx }));
  const item = getPlaybackPlaylist()?.items[idx] ?? pl.items[idx];
  if (!item?.vid) return;
  endHandledForVid = "";
  markQueueTrackIntent(item.vid);
  await ensurePlayer(item.vid);
  if (visibilityGeneration !== playbackVisibilityGeneration || !canPlayInCurrentVisibility()) return;
  if (!ytReady || !playerReady || !yt) {
    pendingIndex = idx;
    return;
  }
  if (autoplay) {
    startMediaPlayback(item.vid);
    setTimeout(() => {
      if (getState().activeMode === "video") {
        applyPlayerSize();
        applyVideoQuality(true);
      } else {
        applyMusicDataSaver(true);
        scheduleMusicSaverRetries();
      }
    }, 400);
  } else cueVideoByIdPlain(item.vid);
}

function resumeFromUserPause(st) {
  const item = getNowPlayingItem();
  const YT = window.YT.PlayerState;
  userResumeRequested = true;
  hardPaused = false;
  pendingForegroundUserResume = false;
  pauseFenceUntil = 0;
  markUserResume();
  intendedPlaying = true;
  userPaused = false;
  cancelFgPauseDefer();
  stopSilentPauseOwner();
  cancelNudgePause();
  cancelNudgePlayback();
  clearTimeout(fgResumeTimer);
  fgResumeTimer = null;
  primeUserGestureAudio();
  const mobile = isMobileDevice();
  const longPause = Date.now() - lastPauseAttemptAt > 25000;
  const coldStart = st === YT.UNSTARTED || st === YT.CUED;
  const mutedKickoff = shouldUseMutedMobileKickoff() && coldStart;
  if (mutedKickoff) {
    try {
      yt.mute();
    } catch {}
  } else {
    ensurePlayerVolume();
  }
  // #region agent log
  debugBg("H-77", "player.js:resumeFromUserPause", "resume-audible-policy", {
    ios: isIOS(),
    mobile,
    coldStart,
    mutedKickoff,
    visibility: document.visibilityState,
  });
  // #endregion
  if (st === YT.UNSTARTED || st === YT.CUED) {
    loadVideoByIdAt(item?.vid);
  } else if (st !== YT.PLAYING) {
    try {
      yt.playVideo();
    } catch {}
  }
  restoreAudioAfterVirtualPause();
  if (longPause && document.visibilityState !== "visible") {
    try {
      ensurePlayerVolume();
      yt.playVideo();
    } catch {}
    nudgePlayback(mobile ? 12 : 6);
    // #region agent log
    debugBg("H-W", "player.js:resumeFromUserPause", "long-pause-resume-recovery", {
      sincePauseMs: Date.now() - lastPauseAttemptAt,
      silentActive: isSilentKeepAliveActive(),
    });
    // #endregion
  } else if (mutedKickoff) restoreVolumeAfterMutedAutoplay();
  else nudgePlayback(mobile ? 10 : 4);
  startBackgroundKeepAlive();
  if (document.visibilityState !== "visible") kickBackgroundWatchdogAfterUserResume();
  // UI/미디어세션은 YT PLAYING 이벤트에서만 재생으로 전환
  // #region agent log
  let ytStateAfter = null;
  try {
    ytStateAfter = yt.getPlayerState();
  } catch {}
  debugBg("H18", "player.js:resumeFromUserPause", "resume-requested", {
    ytStateAfter,
    visibility: document.visibilityState,
    silentOwnerStopped: true,
    fix: "fix79",
  });
  // #endregion
}

export function togglePlaySync() {
  if (!canPlayInCurrentVisibility()) return false;
  const item = getNowPlayingItem();
  if (!item?.vid || !ytReady || !playerReady || !yt) return null;
  const YT = window.YT.PlayerState;
  let st;
  try {
    st = yt.getPlayerState();
  } catch {
    intendedPlaying = true;
    userPaused = false;
    loadVideoByIdAt(item.vid);
    return true;
  }
  // #region agent log
  debugBg("H6", "player.js:togglePlaySync", "toggle-by-yt-state", {
    intendedPlaying,
    userPaused,
    ytState: st,
    visibility: document.visibilityState,
    runId: "post-fix-userPaused",
  });
  // #endregion
  if (userPaused) {
    // #region agent log
    debugBg("H14", "player.js:togglePlaySync", "resume-after-user-pause", {
      ytState: st,
      visibility: document.visibilityState,
    });
    // #endregion
    return resumeAfterUserPause(st, "togglePlaySync");
  }
  if (st === YT.PLAYING) {
    pauseByUser();
    return false;
  }
  if (
    intendedPlaying &&
    !userPaused &&
    !hardPaused &&
    st !== YT.UNSTARTED &&
    st !== YT.CUED
  ) {
    pauseByUser();
    return false;
  }
  intendedPlaying = true;
  userPaused = false;
  hardPaused = false;
  pendingForegroundUserResume = false;
  pauseFenceUntil = 0;
  try {
    if (yt.isMuted?.()) yt.unMute();
    ensurePlayerVolume({ reason: "toggle-visible-start" });
  } catch {}
  if (st === YT.UNSTARTED || st === YT.CUED) {
    startMediaPlayback(item.vid);
    return true;
  } else {
    yt.playVideo();
    nudgePlayback(isMobileDevice() ? 10 : 4);
  }
  startBackgroundKeepAlive();
  return true;
}

export function syncAudioOnForeground() {
  stopBgVirtualPause();
  if (pendingForegroundUserResume) {
    stopNativeAudioForPlayback();
    setPlaying(false);
    // #region agent log
    debugBg("H-52", "player.js:syncAudioOnForeground", "foreground-waiting-for-user-tap", {
      bgPauseHoldPosition,
      lastKnownPlaybackPosition,
      visibility: document.visibilityState,
    });
    // #endregion
    return;
  }
  const now = Date.now();
  if (!deferredBgResume && now - lastForegroundAudioSyncAt < 700) {
    // #region agent log
    debugBg("H-51", "player.js:syncAudioOnForeground", "foreground-sync-throttled", {
      sinceMs: now - lastForegroundAudioSyncAt,
      visibility: document.visibilityState,
    });
    // #endregion
    return;
  }
  lastForegroundAudioSyncAt = now;
  if (deferredBgResume) {
    recoverForegroundResume("deferred-bg-resume");
    return;
  }
  if (!intendedPlaying || userPaused || hardPaused || !ytReady || !yt) return;
  primeUserGestureAudio();
  let ytState = null;
  try {
    ytState = yt.getPlayerState();
  } catch {}
  if (isIOS()) {
    if (hasNativeAudioRouteConflict()) {
      // #region agent log
      debugBg("H-51", "player.js:syncAudioOnForeground", "foreground-route-conflict", {
        ytState,
        ownerActive: isSilentPauseOwnerActive(),
        silentActive: isSilentKeepAliveActive(),
      });
      // #endregion
      stopNativeAudioForPlayback();
      recoverForegroundResume("foreground-route-conflict", ytState);
      return;
    }
    const YT = window.YT.PlayerState;
    if (ytState === YT.PAUSED || ytState === YT.BUFFERING || ytState === YT.CUED || ytState === YT.UNSTARTED) {
      recoverForegroundResume("foreground-stuck-state", ytState);
      return;
    }
    if (ytState === YT.PLAYING) {
      confirmStablePlaying("foreground-playing-state", { ytState }, (stable) => {
        rememberPlaybackPosition(stable.endPos);
        clearResumeHoldPosition("foreground-playing-stable", { ytState, stable });
      });
    }
  } else {
    resumeIfPlaying();
  }
  ensurePlayerVolume();
  if (isMobileDevice()) restoreVolumeAfterMutedAutoplay(isIOS() ? 25 : 15);
  // #region agent log
  let muted = null;
  try {
    muted = yt.isMuted?.();
  } catch {}
  debugBg("H17", "player.js:syncAudioOnForeground", "foreground-audio-restore", {
    muted,
    ytState,
    visibility: document.visibilityState,
  });
  // #endregion
}

let playbackVisibilityGeneration = 0;

export function pauseForBackground() {
  playbackVisibilityGeneration += 1;
  pendingIndex = null;
  if (yt || intendedPlaying) pauseByUser();
}

export function pauseByUser() {
  hiddenMediaSessionResumeGen += 1;
  bgAutoSilentPinGen += 1;
  cancelHiddenAppSwitchResume("explicit-pause");
  clearHiddenAppSwitchPlayingGrace("explicit-pause");
  clearHiddenMediaSessionResume("explicit-pause");
  cancelFgPauseDefer();
  cancelBgUserPauseDetect();
  userResumeRequested = false;
  pendingForegroundUserResume = false;
  bgPlaybackEstablished = false;
  intendedPlaying = false;
  userPaused = true;
  hardPaused = true;
  markPauseAttempt();
  pauseFenceUntil = Date.now() + 10000;
  if (isIOS()) stopNativeAudioForPlayback();
  cancelNudgePause();
  cancelNudgePlayback();
  cancelStablePlayingConfirm();
  clearPendingResumes();
  stopBgVirtualPause();
  // fix47: silent owner는 백그라운드 pause 전용 — 포그라운드에서 켜면 iOS resume 시 YT 오디오 세션 회복 실패
  if (!IOS_REAL_PAUSE_STABILITY && isIOS() && document.visibilityState !== "visible") {
    void startSilentPauseOwner("before-yt-real-pause");
  }
  try {
    bgPauseHoldPosition = getBestResumePosition(getNowPlayingItem());
  } catch {
    bgPauseHoldPosition = 0;
  }
  // #region agent log
  debugBg("H-51", "player.js:pauseByUser", "pause-position-latched", {
    bgPauseHoldPosition,
    lastKnownPlaybackPosition,
    lastKnownPlaybackVid,
    visibility: document.visibilityState,
  });
  // #endregion
  try {
    yt?.pauseVideo?.();
  } catch {}
  // #region agent log
  debugBg("H-42", "player.js:pauseByUser", "yt-real-pause", {
    visibility: document.visibilityState,
    virtualPause: false,
    silentOwner: document.visibilityState !== "visible" && isIOS() && !IOS_REAL_PAUSE_STABILITY,
    silentActive: isSilentKeepAliveActive(),
  });
  debugBg("H11", "player.js:pauseByUser", "explicit-pause", {
    visibility: document.visibilityState,
    ytReady,
    hardPaused,
    virtualPause: false,
    ytState: ytReady && yt ? (() => {
      try {
        return yt.getPlayerState();
      } catch {
        return null;
      }
    })() : null,
  });
  // #endregion
  setPlaying(false);
  if (document.visibilityState === "visible") {
    stopBackgroundKeepAlive();
  }
  nudgePause();
  if (document.visibilityState !== "visible" && isIOS() && !IOS_REAL_PAUSE_STABILITY) {
    startBackgroundKeepAlive({ pauseSession: true });
    void startSilentPrimaryPauseSession().then(() => setPlaying(false));
    maintainBgPauseSession();
  } else if (document.visibilityState !== "visible" && isIOS()) {
    // #region agent log
    debugBg("H-66", "player.js:pauseByUser", "bg-real-pause-no-keepalive", {
      visibility: document.visibilityState,
      userPaused,
      hardPaused,
    });
    // #endregion
  }
}

export function resumeByUser() {
  if (!canPlayInCurrentVisibility()) return false;
  const sincePauseMs = Date.now() - lastPauseAttemptAt;
  if ((userPaused || hardPaused) && sincePauseMs < PAUSE_TO_PLAY_GUARD_MS) {
    // #region agent log
    debugBg("H20", "player.js:resumeByUser", "blocked-spurious-play-after-pause", {
      sincePauseMs,
      hardPaused,
      userPaused,
    });
    // #endregion
    return false;
  }
  const item = getNowPlayingItem();
  if (!item?.vid || !ytReady || !playerReady || !yt) return false;
  let st;
  try {
    st = yt.getPlayerState();
  } catch {
    intendedPlaying = true;
    userPaused = false;
    loadVideoByIdAt(item.vid);
    return true;
  }
  const YT = window.YT.PlayerState;
  if (!userPaused && st === YT.PLAYING) {
    if (hasNativeAudioRouteConflict()) {
      stopNativeAudioForPlayback();
      return recoverForegroundResume("resumeByUser-playing-route-conflict", st);
    }
    return true;
  }
  // #region agent log
  debugBg("H14", "player.js:resumeByUser", "explicit-resume", {
    ytState: st,
    userPaused,
    visibility: document.visibilityState,
  });
  // #endregion
  lastUserPlayGestureAt = Date.now();
  primeUserGestureAudio();
  if (!isIOS()) {
    startBackgroundKeepAlive();
  }
  // #region agent log
  debugBg("H-W", "player.js:resumeByUser", "resume-gesture", {
    sincePauseMs,
    silentActive: isSilentKeepAliveActive(),
    visibility: document.visibilityState,
  });
  // #endregion
  return resumeAfterUserPause(st, "resumeByUser");
}

export async function togglePlay() {
  if (!canPlayInCurrentVisibility()) return false;
  const item = getNowPlayingItem();
  if (!item?.vid) return false;

  const synced = togglePlaySync();
  if (synced !== null) return synced;

  const visibilityGeneration = playbackVisibilityGeneration;
  intendedPlaying = true;
  userPaused = false;
  await ensurePlayer(getNowPlayingItem()?.vid);
  if (visibilityGeneration !== playbackVisibilityGeneration) return false;
  return togglePlaySync() ?? true;
}

function stopPlayback(pausePlayer = true) {
  intendedPlaying = false;
  userPaused = false;
  setPlaying(false);
  if (pausePlayer && ytReady && yt) {
    try {
      yt.pauseVideo();
    } catch {}
  }
}

/** 대기열에서 현재 곡을 넘기고 다음 곡 재생 (또는 종료/전체 반복) */
function advanceWaitingQueue(autoplay = true, { userInitiated = false, fromEnd = false } = {}) {
  // #region agent log
  logPlayTransport("advanceWaitingQueue-enter", "fix71", { userInitiated });
  // #endregion
  if (!hasWaitingQueueItems()) {
    if (isQueuePlaybackMode()) leaveQueuePlaybackMode();
    if (userInitiated) {
      suppressLibraryAdvance();
      // #region agent log
      logPlayTransport("advanceWaitingQueue-no-op-empty");
      // #endregion
      return;
    }
    suppressLibraryAdvance();
    stopPlayback(true);
    if (fromEnd) notifyTrackEnd();
    return;
  }

  enterQueuePlaybackMode();
  const pl = getWaitingQueueAsPlaylist();

  if (hasForwardQueuedTrack()) {
    const fwd = takeForwardTrack();
    if (!fwd) return;
    const idx = replaceCurrentQueueTrack(fwd);
    if (idx < 0) return;
    suppressBackStackPushOnce();
    void playIndex(idx, autoplay);
    return;
  }

  const repeatAll = pl.repeat === "all";

  if (!hasUpcomingWaitingTracks()) {
    if (userInitiated) {
      suppressLibraryAdvance();
      // #region agent log
      logPlayTransport("advanceWaitingQueue-no-op-no-upcoming");
      // #endregion
      return;
    }
    if (repeatAll) {
      rotateWaitingQueueTrackToEnd();
      void playIndex(getPlaybackPlaylist().cur, autoplay, { skipQueuePrepare: true });
      return;
    }
    finishWaitingQueueTrack();
    if (!hasWaitingQueueItems()) leaveQueuePlaybackMode();
    suppressLibraryAdvance();
    // #region agent log
    logPlayTransport("advanceWaitingQueue-stop-no-upcoming");
    // #endregion
    stopPlayback(true);
    if (fromEnd) notifyTrackEnd();
    return;
  }

  if (repeatAll) {
    rotateWaitingQueueTrackToEnd();
  } else {
    finishWaitingQueueTrack();
    if (!hasWaitingQueueItems()) {
      leaveQueuePlaybackMode();
      suppressLibraryAdvance();
      stopPlayback(true);
      return;
    }
  }
  void playIndex(getPlaybackPlaylist().cur, autoplay, { skipQueuePrepare: true });
}

export function playNext(autoplay = true) {
  if (!canPlayInCurrentVisibility()) return;
  // #region agent log
  logPlayTransport("playNext-enter");
  // #endregion
  if (isWaitingQueueActive()) {
    advanceWaitingQueue(autoplay, { userInitiated: true });
    return;
  }
  const pl = getPlaybackPlaylist();
  if (!pl?.items?.length) {
    // #region agent log
    logPlayTransport("playNext-no-op-empty-queue");
    // #endregion
    return;
  }
  void playIndex(nextIndex(pl, 1), autoplay);
}

export function playPrev(autoplay = true) {
  if (!canPlayInCurrentVisibility()) return;
  if (isWaitingQueueActive()) {
    if (!hasPreviousPlayedTrack()) return;
    enterQueuePlaybackMode();
    const prev = takePreviousPlayedTrack();
    if (!prev) return;
    const pl = getPlaybackPlaylist();
    const current = getCurrentItem(pl);
    if (current?.vid) pushForwardTrack(current);
    const idx = replaceCurrentQueueTrack(prev);
    if (idx < 0) return;
    suppressBackStackPushOnce();
    // #region agent log
    logPlayTransport("playPrev-queue", "pre-fix", { backStackAfterPop: getPlaybackBackStackLength() });
    // #endregion
    void playIndex(idx, autoplay);
    return;
  }
  const pl = getPlaybackPlaylist();
  if (!pl?.items?.length) return;
  void playIndex(nextIndex(pl, -1), autoplay);
}

export function toggleShuffle() {
  if (isWaitingQueueActive()) {
    toggleWaitingQueueShuffle();
    return;
  }
  const pl = getPlaybackPlaylist();
  if (!pl) return;
  updatePlaybackPlaylist((p) => {
    const shuffle = !p.shuffle;
    let shuffleOrder = p.shuffleOrder;
    if (shuffle) {
      shuffleOrder = p.items.map((_, i) => i);
      for (let i = shuffleOrder.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffleOrder[i], shuffleOrder[j]] = [shuffleOrder[j], shuffleOrder[i]];
      }
    }
    return { ...p, shuffle, shuffleOrder };
  });
}

export function cycleRepeat() {
  const order = ["all", "one", "off"];
  if (isWaitingQueueActive()) {
    const q = getState().waitingQueue ?? {};
    const repeat = q.repeat ?? getState().defaultRepeat ?? "all";
    const next = order[(order.indexOf(repeat) + 1) % order.length];
    patchState({ waitingQueue: { ...q, repeat: next } });
    return next;
  }
  const pl = getPlaybackPlaylist();
  if (!pl) return "all";
  const repeat = pl.repeat ?? getState().defaultRepeat ?? "all";
  const next = order[(order.indexOf(repeat) + 1) % order.length];
  updatePlaybackPlaylist((p) => ({ ...p, repeat: next }));
  return next;
}

export function setVolume(val, { userInitiated = true } = {}) {
  const requestedVolume = clampPlayerVolume(val);
  const targetVolume = userInitiated ? requestedVolume : getTargetPlayerVolume();
  if (userInitiated) patchState({ volume: requestedVolume, volumeTouched: true });
  if (ytReady && yt?.setVolume) {
    try {
      yt.setVolume(targetVolume);
      if (targetVolume > 0 && yt.isMuted?.()) yt.unMute();
    } catch {}
  }
}

export function getPlaybackProgress() {
  if (!ytReady || !yt?.getDuration) return { cur: 0, dur: 0 };
  try {
    return {
      cur: yt.getCurrentTime() || 0,
      dur: yt.getDuration() || 0,
    };
  } catch {
    return { cur: 0, dur: 0 };
  }
}

export function seekTo(ratio) {
  if (!ytReady || !yt?.getDuration) return 0;
  let dur = 0;
  try {
    dur = yt.getDuration() || 0;
  } catch {
    return 0;
  }
  if (dur <= 0) return 0;
  const time = Math.max(0, Math.min(dur, dur * ratio));
  try {
    yt.seekTo(time, true);
  } catch {}
  onProgress?.(time, dur);
  return time;
}

export async function applyMode(mode) {
  if (mode !== "video") {
    lastLargePlayerView = false;
    lastBoostReloadKey = "";
  } else {
    clearMusicSaverRetries();
  }

  if (mode === getState().activeMode) {
    getMount(mode);
    if (mode === "video") {
      applyPlayerSize();
      applyVideoQuality(true);
    } else {
      applyMusicDataSaver(true);
      scheduleMusicSaverRetries();
    }
    return;
  }

  let savedTime = 0;
  let wasPlaying = false;

  if (yt && ytReady) {
    try {
      savedTime = yt.getCurrentTime() || 0;
      const st = yt.getPlayerState();
      wasPlaying = intendedPlaying || st === window.YT.PlayerState.PLAYING;
    } catch {}
  }

  modeSwitchUntil = Date.now() + 1200;
  patchState({ activeMode: mode });
  getMount(mode);

  const item = getNowPlayingItem();
  if (!item) return;

  const resume = () => {
    if (yt && ytReady) {
      try {
        const currentVid = yt.getVideoData?.()?.video_id;
        if (currentVid === item.vid) {
          restorePlayback(savedTime, wasPlaying);
          if (mode === "video" && wasPlaying) {
            setTimeout(() => {
              applyVideoQuality(true);
            }, 1500);
          }
          if (mode === "music") scheduleMusicSaverRetries();
          return;
        }
      } catch {}
    }
    ensurePlayer(item.vid).then(() => {
      if (yt && ytReady) {
        try {
          cueVideoByIdPlain(item.vid);
          restorePlayback(savedTime, wasPlaying);
        } catch {}
      }
    });
  };

  requestAnimationFrame(() => requestAnimationFrame(resume));
}

export function destroyProgress() {
  clearInterval(progTimer);
  clearQualityRetries();
  clearMusicSaverRetries();
}

export function isCurrentlyPlaying() {
  if (!ytReady || !yt) return false;
  try {
    return yt.getPlayerState() === window.YT.PlayerState.PLAYING;
  } catch {
    return false;
  }
}

export function shouldResumeAfterVisible() {
  return intendedPlaying && !userPaused && !hardPaused && !pendingForegroundUserResume;
}

/** watchdog: bg에서 한번 재생 안정화된 뒤 PAUSED면 자동재개 중단 */
export function shouldBgWatchdogResume() {
  if (!shouldResumeAfterVisible()) return false;
  if (document.visibilityState !== "visible") {
    if (IOS_USER_CONTROL_STABILITY && IOS_REAL_PAUSE_STABILITY && isIOS()) {
      // #region agent log
      debugBg("H-68", "player.js:shouldBgWatchdogResume", "hidden-watchdog-resume-disabled", {
        bgPlaybackEstablished,
        hiddenForMs: getBackgroundHiddenForMs(),
        intendedPlaying,
        userPaused,
        hardPaused,
      });
      // #endregion
      return false;
    }
    return isIOS() && !bgPlaybackEstablished && getBackgroundHiddenForMs() < BG_APP_SWITCH_AUTO_RESUME_MS;
  }
  if (bgPlaybackEstablished && ytReady && yt) {
    try {
      if (yt.getPlayerState() === window.YT.PlayerState.PAUSED) return false;
    } catch {}
  }
  return true;
}

/** bg pause 중 잠금화면·오디오 세션 유지 */
export function shouldKeepBgSessionAlive() {
  if (!isIOS()) return false;
  if (document.visibilityState === "visible") return false;
  if (IOS_REAL_PAUSE_STABILITY && (userPaused || hardPaused)) return false;
  if (bgVirtualPaused) return true;
  if (!userPaused && !hardPaused) return false;
  return Boolean(getNowPlayingItem()?.vid);
}

/** visibility hidden 직전 PAUSED가 intendedPlaying을 지워버린 레이스 복구 */
export function prepareForBackground() {
  if (userPaused || hardPaused) return;
  bgPlaybackEstablished = false;
  const item = getNowPlayingItem();
  if (!item?.vid) return;
  rememberPlaybackPosition();
  if (!intendedPlaying) {
    intendedPlaying = true;
    // #region agent log
    debugBg("H7", "player.js:prepareForBackground", "restore-intendedPlaying", {
      userPaused,
      visibility: document.visibilityState,
    });
    // #endregion
  }
  let ytState = null;
  try {
    ytState = ytReady && yt ? yt.getPlayerState() : null;
  } catch {}
  // #region agent log
  debugBg("H-61", "player.js:prepareForBackground", "background-prepare-resume-window", {
    ytState,
    intendedPlaying,
    bgPlaybackEstablished,
    visibility: document.visibilityState,
  });
  // #endregion
  if (isIOS() && intendedPlaying && !userPaused && !hardPaused && ytState === window.YT?.PlayerState?.PLAYING) {
    pinHiddenAppSwitchPlayingGrace("prepare-background", IOS_BG_HANDOFF_GRACE_MS, {
      ytState,
      lastKnownPlaybackPosition,
    });
    setPlaying(true);
    startBackgroundKeepAlive();
  }
  scheduleHiddenPlayingMediaSessionRefresh("prepare-background");
  scheduleHiddenAppSwitchResume("prepare-background");
}

export function resumeIfPlaying() {
  // #region agent log
  debugBg("H2", "player.js:resumeIfPlaying", "enter", {
    intendedPlaying,
    userPaused,
    hardPaused,
    resumeGen: resumeIfPlayingGen + 1,
    ytReady,
    visibility: document.visibilityState,
    playerState: ytReady && yt ? (() => {
      try {
        return yt.getPlayerState();
      } catch {
        return null;
      }
    })() : null,
  });
  // #endregion
  if (document.visibilityState !== "visible") {
    let hiddenAutoResumeQueued = false;
    let hiddenState = null;
    try {
      hiddenState = ytReady && yt ? yt.getPlayerState() : null;
    } catch {}
    if (hiddenState === window.YT?.PlayerState?.PLAYING) {
      bgPlaybackEstablished = true;
      setPlaying(true);
      startProgress();
      startBackgroundKeepAlive();
    } else if (IOS_USER_CONTROL_STABILITY && IOS_REAL_PAUSE_STABILITY && isIOS()) {
      // #region agent log
      debugBg("H-68", "player.js:resumeIfPlaying", "hidden-auto-resume-disabled", {
        hiddenState,
        userPaused,
        hardPaused,
        intendedPlaying,
        hiddenForMs: getBackgroundHiddenForMs(),
      });
      // #endregion
    } else if (isIOS() && shouldAllowAutoResume() && getBackgroundHiddenForMs() < BG_APP_SWITCH_AUTO_RESUME_MS) {
      hiddenAutoResumeQueued = scheduleHiddenAppSwitchResume("resumeIfPlaying-hidden");
    }
    // #region agent log
    debugBg("H-61", "player.js:resumeIfPlaying", hiddenAutoResumeQueued ? "hidden-auto-resume-queued" : "hidden-auto-resume-observed", {
      hiddenState,
      ios: isIOS(),
      userPaused,
      hardPaused,
      intendedPlaying,
      pendingForegroundUserResume,
      hiddenForMs: getBackgroundHiddenForMs(),
      hiddenAutoResumeQueued,
    });
    // #endregion
    return;
  }
  if (!shouldAllowAutoResume() || !ytReady || !yt) return;

  if (shouldAdvanceTrack()) {
    onTrackEnded();
    return;
  }

  const gen = ++resumeIfPlayingGen;
  markResumeAttempt();
  const YT = window.YT.PlayerState;
  const attempt = (n = 0) => {
    if (gen !== resumeIfPlayingGen || !ytReady || !yt || !intendedPlaying || userPaused || hardPaused) {
      // #region agent log
      if (gen === resumeIfPlayingGen && (userPaused || hardPaused)) {
        debugBg("H22", "player.js:resumeIfPlaying", "attempt-aborted-paused", { n, hardPaused, userPaused });
      }
      // #endregion
      return;
    }
    try {
      const st = yt.getPlayerState();
      if (st === YT.PLAYING) {
        if (hasNativeAudioRouteConflict()) {
          // #region agent log
          debugBg("H-51", "player.js:resumeIfPlaying", "route-conflict-before-playing-confirm", {
            n,
            hiddenForMs: getBackgroundHiddenForMs(),
            ownerActive: isSilentPauseOwnerActive(),
            silentActive: isSilentKeepAliveActive(),
          });
          // #endregion
          stopNativeAudioForPlayback();
          setPlaying(false);
          if (document.visibilityState === "visible") {
            recoverForegroundResume("resumeIfPlaying-route-conflict", st);
          }
          if (n < 8) setTimeout(() => attempt(n + 1), 250);
          return;
        }
        const commitResumePlaying = (stable = {}) => {
          if (document.visibilityState !== "visible") bgPlaybackEstablished = true;
          // #region agent log
          debugBg("H-M", "player.js:resumeIfPlaying", "attempt-confirmed-playing", {
            n,
            hiddenForMs: getBackgroundHiddenForMs(),
            bgPlaybackEstablished,
            stable,
          });
          // #endregion
          markStablePlaying();
          rememberPlaybackPosition(stable.endPos);
          clearResumeHoldPosition("resumeIfPlaying-confirmed", { n, stable });
          setPlaying(true);
          startProgress();
          ensurePlayerVolume();
          if (isMobileDevice()) restoreVolumeAfterMutedAutoplay(isIOS() ? 20 : 10);
        };
        if (confirmStablePlaying("resumeIfPlaying", { n }, commitResumePlaying)) return;
        commitResumePlaying();
        return;
      }
      if (st === YT.PAUSED || st === YT.CUED || st === YT.BUFFERING || st === YT.UNSTARTED) {
        // #region agent log
        debugBg("H22", "player.js:resumeIfPlaying", "playVideo-called", { n, st });
        // #endregion
        yt.playVideo();
      }
      if (n < 8) setTimeout(() => attempt(n + 1), 250);
    } catch {
      if (n < 8) setTimeout(() => attempt(n + 1), 250);
    }
  };

  attempt();
}
