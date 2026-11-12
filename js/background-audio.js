import { debugBg } from "./debug-log.js";

const BACKGROUND_PLAYBACK_ENABLED = false;

export function canPlayInCurrentVisibility() {
  return BACKGROUND_PLAYBACK_ENABLED || document.visibilityState === "visible";
}

export function bindForegroundOnlyPlayback(pause) {
  if (BACKGROUND_PLAYBACK_ENABLED) return;
  document.addEventListener("visibilitychange", () => {
    if (!canPlayInCurrentVisibility()) pause();
  });
  window.addEventListener("pagehide", pause);
}

let ctx = null;
let node = null;
let silentAudio = null;
let silentAudioStopGen = 0;
let pauseOwnerAudio = null;
let pauseOwnerUrl = null;
let lastPauseOwnerOkAt = 0;
let lastPauseOwnerFailAt = 0;
let lastPauseOwnerError = "";

/** fix46/Codex: 12분 디지털 silence — YT real pause 중 iOS audio owner */
const SILENT_OWNER_SECONDS = 720;
const SILENT_OWNER_SAMPLE_RATE = 8000;

function writeWavHeader(view, numFrames, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = numChannels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;
  view.setUint32(0, 0x46464952, true);
  view.setUint32(4, 36 + dataSize, true);
  view.setUint32(8, 0x45564157, true);
  view.setUint32(12, 0x20746d66, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  view.setUint32(36, 0x61746164, true);
  view.setUint32(40, dataSize, true);
}

function createSilentOwnerUrl() {
  if (pauseOwnerUrl) return pauseOwnerUrl;
  const frames = SILENT_OWNER_SECONDS * SILENT_OWNER_SAMPLE_RATE;
  const bytes = 44 + frames * 2;
  const buf = new ArrayBuffer(bytes);
  writeWavHeader(new DataView(buf), frames, SILENT_OWNER_SAMPLE_RATE);
  pauseOwnerUrl = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  return pauseOwnerUrl;
}

function ensurePauseOwnerAudio() {
  if (pauseOwnerAudio) {
    if (!pauseOwnerAudio.src) pauseOwnerAudio.src = createSilentOwnerUrl();
    return pauseOwnerAudio;
  }
  pauseOwnerAudio = new Audio(createSilentOwnerUrl());
  pauseOwnerAudio.loop = false;
  pauseOwnerAudio.volume = 1;
  pauseOwnerAudio.muted = false;
  pauseOwnerAudio.setAttribute("playsinline", "");
  pauseOwnerAudio.preload = "auto";
  return pauseOwnerAudio;
}

function isIOS() {
  return (
    /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function canUsePauseOwner(reason) {
  const keepPauseSession = Boolean(shouldKeepBgSessionAliveFn?.());
  if (keepPauseSession) return true;
  // #region agent log
  debugBg("H-49", "background-audio.js:canUsePauseOwner", "silent-owner-blocked-during-play", {
    reason,
    visibility: document.visibilityState,
    shouldResume: Boolean(shouldResumeFn?.()),
  });
  // #endregion
  return false;
}

export async function startSilentPauseOwner(reason = "unknown") {
  if (!BACKGROUND_PLAYBACK_ENABLED) return false;
  if (!canUsePauseOwner(reason)) return false;
  const audio = ensurePauseOwnerAudio();
  if (audio.currentTime > SILENT_OWNER_SECONDS - 30) audio.currentTime = 0;
  try {
    await audio.play();
    // #region agent log
    debugBg("H-46", "background-audio.js:startSilentPauseOwner", "silent-owner-play-ok", {
      reason,
      paused: audio.paused,
      currentTime: audio.currentTime,
    });
    // #endregion
    lastPauseOwnerOkAt = Date.now();
    return true;
  } catch (err) {
    lastPauseOwnerFailAt = Date.now();
    lastPauseOwnerError = String(err?.message || err);
    // #region agent log
    debugBg("H-46", "background-audio.js:startSilentPauseOwner", "silent-owner-play-fail", {
      reason,
      err: String(err?.message || err),
    });
    // #endregion
    return false;
  }
}

export function stopSilentPauseOwner() {
  if (!pauseOwnerAudio) return;
  try {
    pauseOwnerAudio.pause();
    pauseOwnerAudio.currentTime = 0;
    // iOS: src 해제로 오디오 세션을 YT iframe에 반환
    if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
      pauseOwnerAudio.removeAttribute("src");
      pauseOwnerAudio.load();
    }
  } catch {}
}

export function isSilentPauseOwnerActive() {
  return Boolean(pauseOwnerAudio && !pauseOwnerAudio.paused);
}

export function getPauseOwnerStatus() {
  return {
    ownerActive: isSilentPauseOwnerActive(),
    lastOkAgoMs: lastPauseOwnerOkAt ? Date.now() - lastPauseOwnerOkAt : null,
    lastFailAgoMs: lastPauseOwnerFailAt ? Date.now() - lastPauseOwnerFailAt : null,
    lastError: lastPauseOwnerError,
  };
}

export function stopNativeAudioForPlayback() {
  stopSilentPauseOwner();
  stopOscillatorKeepAlive();
  hardStopSilentAudioKeepAlive();
  active = false;
  // #region agent log
  debugBg("H-51", "background-audio.js:stopNativeAudioForPlayback", "native-audio-hard-stopped-for-yt", {
    visibility: document.visibilityState,
    ownerActive: isSilentPauseOwnerActive(),
    silentActive: isSilentKeepAliveActive(),
  });
  // #endregion
}

let wakeLock = null;
let active = false;
let watchdog = null;
let resumeFn = null;
let shouldResumeFn = null;
let shouldWatchdogResumeFn = null;
let prepareBackgroundFn = null;
let restoreAudioFn = null;
let backgroundHiddenAt = 0;

/** 앱 전환 직후에만 watchdog resume (player.js BG_APP_SWITCH_GRACE_MS와 동일 값 유지)
 * H-M: 3000 → 20000. player.js 쪽 값과 반드시 같이 바꿀 것. */
const BG_WATCHDOG_GRACE_MS = 20000;
/** 사용자 resume 후 watchdog 유지 (pause 길이와 무관) */
const BG_USER_RESUME_WATCHDOG_MS = 120000;
/** bg 사용자 pause 중 iOS 세션/잠금화면 유지 */
const BG_PAUSE_SESSION_MS = 600000;
let watchdogUntil = 0;
let shouldKeepBgSessionAliveFn = null;
let onPauseSessionHeartbeatFn = null;
let pauseSessionHeartbeat = null;

export function extendBgWatchdogForUserResume(ms = BG_WATCHDOG_GRACE_MS) {
  watchdogUntil = Math.max(watchdogUntil, Date.now() + ms);
  // #region agent log
  debugBg("H-P", "background-audio.js:extendBgWatchdog", "extended", {
    remainingMs: watchdogUntil - Date.now(),
  });
  // #endregion
}

export function kickBackgroundWatchdogAfterUserResume() {
  if (!BACKGROUND_PLAYBACK_ENABLED) return;
  if (document.visibilityState === "visible") return;
  stopPauseSessionHeartbeat();
  extendBgWatchdogForUserResume(BG_USER_RESUME_WATCHDOG_MS);
  primeUserGestureAudio();
  startBackgroundKeepAlive();
  forceStartWatchdog(false);
}

function stopPauseSessionHeartbeat() {
  if (pauseSessionHeartbeat) {
    clearInterval(pauseSessionHeartbeat);
    pauseSessionHeartbeat = null;
  }
}

function startPauseSessionHeartbeat() {
  stopPauseSessionHeartbeat();
  pauseSessionHeartbeat = setInterval(() => {
    if (!shouldKeepBgSessionAliveFn?.()) {
      stopPauseSessionHeartbeat();
      return;
    }
    onPauseSessionHeartbeatFn?.();
    const hiddenForMs = getBackgroundHiddenForMs();
    refreshBgSessionKeepAlive(hiddenForMs);
    // #region agent log
    if (hiddenForMs >= 55000 && hiddenForMs < 65000) {
      debugBg("H-X", "background-audio.js:pauseSessionHeartbeat", "pause-60s-checkpoint", {
        hiddenForMs,
        silentActive: isSilentKeepAliveActive(),
        watchdogRemainingMs: watchdogUntil - Date.now(),
      });
    }
    // #endregion
  }, 5000);
}

/** bg pause 중 watchdog/keep-alive 유지 — H-L 만료로 잠금화면·resume 경로가 사라지는 것 방지 */
export function maintainBgPauseSession() {
  if (!BACKGROUND_PLAYBACK_ENABLED) return;
  if (!isIOS()) return;
  if (document.visibilityState === "visible") return;
  extendBgWatchdogForUserResume(BG_PAUSE_SESSION_MS);
  primeUserGestureAudio();
  startBackgroundKeepAlive({ pauseSession: true });
  forceStartWatchdog(true);
  startPauseSessionHeartbeat();
  onPauseSessionHeartbeatFn?.();
  // #region agent log
  debugBg("H-Q", "background-audio.js:maintainBgPauseSession", "pause-session-maintained", {
    remainingMs: watchdogUntil - Date.now(),
  });
  // #endregion
}

function refreshBgSessionKeepAlive(hiddenForMs) {
  stopOscillatorKeepAlive();
  startBackgroundKeepAlive({ pauseSession: true });
  primeUserGestureAudio();
  const recentFail = lastPauseOwnerFailAt && Date.now() - lastPauseOwnerFailAt < 30000;
  if (!recentFail) {
    void startSilentPauseOwner("keepalive");
    void startSilentAudioKeepAlive();
  }
  // #region agent log
  debugBg("H-Q", "background-audio.js:watchdog", "pause-session-keepalive-tick", {
    hiddenForMs,
    silentActive: isSilentKeepAliveActive(),
    ownerActive: isSilentPauseOwnerActive(),
  });
  // #endregion
}

function forceStartWatchdog(skipInitialResume = false) {
  stopWatchdog();
  if (!resumeFn) return;
  if (!skipInitialResume) resumeFn();
  watchdog = setInterval(() => {
    const hiddenForMs = getBackgroundHiddenForMs();
    const keepPauseSession = Boolean(shouldKeepBgSessionAliveFn?.());
    if (Date.now() >= watchdogUntil) {
      if (keepPauseSession) {
        extendBgWatchdogForUserResume(BG_PAUSE_SESSION_MS);
        refreshBgSessionKeepAlive(hiddenForMs);
        return;
      }
      // #region agent log
      debugBg("H-L", "background-audio.js:watchdog", "watchdog-stop-grace-expired", {
        hiddenForMs,
        graceMs: BG_WATCHDOG_GRACE_MS,
        watchdogRemaining: 0,
      });
      // #endregion
      stopWatchdog();
      return;
    }
    if (!shouldWatchdogResumeFn?.()) {
      if (keepPauseSession) refreshBgSessionKeepAlive(hiddenForMs);
      // #region agent log
      debugBg("H-N", "background-audio.js:watchdog", "watchdog-skip-established-paused", {
        hiddenForMs,
        keepPauseSession,
      });
      // #endregion
      return;
    }
    if (!shouldResumeFn?.()) {
      if (keepPauseSession) {
        refreshBgSessionKeepAlive(hiddenForMs);
        return;
      }
      // #region agent log
      debugBg("H2", "background-audio.js:watchdog", "watchdog-stop-shouldResume-false", {
        visibility: document.visibilityState,
      });
      // #endregion
      stopWatchdog();
      return;
    }
    startBackgroundKeepAlive();
    resumeFn();
    // #region agent log
    debugBg("H5", "background-audio.js:watchdog", "watchdog-resume-tick", {
      visibility: document.visibilityState,
      hiddenForMs,
    });
    // #endregion
  }, 1500);
}

export function getBackgroundHiddenForMs() {
  if (!backgroundHiddenAt) return 0;
  return Date.now() - backgroundHiddenAt;
}

const SILENT_WAV =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==";

function ensureContext() {
  if (ctx) return ctx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  ctx = new Ctx();
  return ctx;
}

function ensureSilentAudio() {
  if (silentAudio) return silentAudio;
  silentAudio = new Audio(SILENT_WAV);
  silentAudio.loop = true;
  silentAudio.volume = 0.001;
  silentAudio.setAttribute("playsinline", "");
  silentAudio.preload = "auto";
  return silentAudio;
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    if (wakeLock) return;
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch {}
}

async function releaseWakeLock() {
  try {
    await wakeLock?.release?.();
  } catch {}
  wakeLock = null;
}

function startOscillatorKeepAlive() {
  const audioCtx = ensureContext();
  if (!audioCtx) return;
  try {
    if (audioCtx.state === "suspended") audioCtx.resume();
    if (node) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    gain.gain.value = 0.0001;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    node = osc;
  } catch {}
}

export async function startSilentPrimaryPauseSession() {
  if (!BACKGROUND_PLAYBACK_ENABLED) return false;
  if (!isIOS()) return false;
  primeUserGestureAudio();
  await startSilentPauseOwner("pause-session");
  startOscillatorKeepAlive();
  await startSilentAudioKeepAlive();
  const ownerActive = isSilentPauseOwnerActive();
  const silentActive = isSilentKeepAliveActive();
  // #region agent log
  debugBg(
    "H-42",
    "background-audio.js:startSilentPrimaryPauseSession",
    ownerActive || silentActive ? "silent-primary-active" : "silent-primary-fail",
    {
      ownerActive,
      silentActive,
      visibility: document.visibilityState,
    }
  );
  // #endregion
  return ownerActive || silentActive;
}

export async function startSilentAudioKeepAlive() {
  if (!BACKGROUND_PLAYBACK_ENABLED) return false;
  const gen = silentAudioStopGen;
  let audio = ensureSilentAudio();
  if (!audio.paused) {
    // #region agent log
    debugBg("H3", "background-audio.js:startSilentAudioKeepAlive", "silent-audio-already-playing", {
      paused: audio.paused,
    });
    // #endregion
    return;
  }
  try {
    await audio.play();
    if (gen !== silentAudioStopGen || silentAudio !== audio) {
      hardStopAudioElement(audio);
      return;
    }
    // #region agent log
    debugBg("H3", "background-audio.js:startSilentAudioKeepAlive", "silent-audio-play-ok", {
      paused: audio.paused,
    });
    // #endregion
  } catch (err) {
    try {
      silentAudio = null;
      audio = ensureSilentAudio();
      await audio.play();
      if (gen !== silentAudioStopGen || silentAudio !== audio) {
        hardStopAudioElement(audio);
        return;
      }
      // #region agent log
      debugBg("H3", "background-audio.js:startSilentAudioKeepAlive", "silent-audio-retry-ok", {
        paused: audio.paused,
      });
      // #endregion
    } catch (err2) {
      // #region agent log
      debugBg("H3", "background-audio.js:startSilentAudioKeepAlive", "silent-audio-play-fail", {
        err: String(err2?.message || err2 || err?.message || err),
      });
      // #endregion
    }
  }
}

function stopOscillatorKeepAlive() {
  try {
    node?.stop?.();
    node?.disconnect?.();
  } catch {}
  node = null;
}

function stopSilentAudioKeepAlive() {
  if (!silentAudio) return;
  try {
    silentAudio.pause();
    silentAudio.currentTime = 0;
  } catch {}
}

function hardStopAudioElement(audio) {
  if (!audio) return;
  try {
    audio.pause();
    audio.currentTime = 0;
    if (isIOS()) {
      audio.removeAttribute("src");
      audio.load();
    }
  } catch {}
}

function hardStopSilentAudioKeepAlive() {
  silentAudioStopGen += 1;
  const audio = silentAudio;
  silentAudio = null;
  hardStopAudioElement(audio);
}

export function isSilentKeepAliveActive() {
  return Boolean(silentAudio && !silentAudio.paused);
}

export function primeForegroundSilentKeepAlive() {
  primeUserGestureAudio();
  // fix48: active playback must not start native silent audio on iOS.
  startBackgroundKeepAlive();
  // #region agent log
  debugBg("H-48", "background-audio.js:primeForegroundSilentKeepAlive", "foreground-prime-no-owner", {
    visibility: document.visibilityState,
  });
  // #endregion
}

export function primeUserGestureAudio() {
  const audioCtx = ensureContext();
  if (audioCtx?.state === "suspended") void audioCtx.resume();
}

export function startBackgroundKeepAlive({ pauseSession = false } = {}) {
  if (!BACKGROUND_PLAYBACK_ENABLED) return;
  if (active) {
    if (pauseSession && isIOS()) {
      startOscillatorKeepAlive();
      void startSilentAudioKeepAlive();
    }
    requestWakeLock();
    return;
  }
  active = true;
  if (pauseSession && isIOS()) {
    startOscillatorKeepAlive();
    void startSilentAudioKeepAlive();
  } else {
    // #region agent log
    debugBg("H-53", "background-audio.js:startBackgroundKeepAlive", "keepalive-no-native-audio", {
      visibility: document.visibilityState,
      pauseSession,
      ios: isIOS(),
    });
    // #endregion
  }
  requestWakeLock();
}

export function stopBackgroundKeepAlive() {
  stopWatchdog();
  if (!active) return;
  active = false;
  stopOscillatorKeepAlive();
  stopSilentAudioKeepAlive();
  releaseWakeLock();
}

function stopWatchdog() {
  if (watchdog) {
    clearInterval(watchdog);
    watchdog = null;
  }
}

function startWatchdog() {
  if (!shouldWatchdogResumeFn?.() || !resumeFn) {
    // #region agent log
    debugBg("H2", "background-audio.js:startWatchdog", "watchdog-abort", {
      shouldResume: Boolean(shouldResumeFn?.()),
      shouldWatchdog: Boolean(shouldWatchdogResumeFn?.()),
      hasResumeFn: Boolean(resumeFn),
    });
    // #endregion
    return;
  }
  forceStartWatchdog();
}

function onEnterBackground() {
  const alreadyHidden = Boolean(backgroundHiddenAt);
  if (!backgroundHiddenAt) backgroundHiddenAt = Date.now();
  if (!watchdogUntil) watchdogUntil = Date.now() + BG_WATCHDOG_GRACE_MS;
  const shouldBeforePrepare = Boolean(shouldResumeFn?.());
  const keepBeforePrepare = Boolean(shouldKeepBgSessionAliveFn?.());
  if (!alreadyHidden) prepareBackgroundFn?.();
  const should = Boolean(shouldResumeFn?.());
  const keepPauseSession = Boolean(shouldKeepBgSessionAliveFn?.());
  // #region agent log
  debugBg("H2", "background-audio.js:onEnterBackground", "enter-background", {
    shouldResume: should,
    keepPauseSession,
    shouldBeforePrepare,
    keepBeforePrepare,
    preparedBeforeDecision: !alreadyHidden,
    visibility: document.visibilityState,
    active,
    alreadyHidden,
  });
  // #endregion
  primeUserGestureAudio();
  startBackgroundKeepAlive();
  if (keepPauseSession) maintainBgPauseSession();
  if (alreadyHidden) {
    // #region agent log
    debugBg("H-J", "background-audio.js:onEnterBackground", "enter-background-dedup-skip", {
      hiddenForMs: getBackgroundHiddenForMs(),
    });
    // #endregion
    return;
  }
  if (!should || keepPauseSession) return;
  resumeFn?.();
  startWatchdog();
}

function onReturnToForeground() {
  backgroundHiddenAt = 0;
  watchdogUntil = 0;
  stopPauseSessionHeartbeat();
  stopWatchdog();
  restoreAudioFn?.();
  if (shouldResumeFn?.()) {
    setTimeout(() => resumeFn?.(), 100);
    setTimeout(() => restoreAudioFn?.(), 350);
    setTimeout(() => resumeFn?.(), 600);
  }
}

export function initBackgroundPlayback({ pauseForBackground, shouldResume, shouldWatchdogResume, shouldKeepBgSessionAlive, onPauseSessionHeartbeat, resumePlayback, prepareForBackground, restoreAudioOnForeground }) {
  if (!BACKGROUND_PLAYBACK_ENABLED) {
    bindForegroundOnlyPlayback(pauseForBackground);
    return;
  }
  shouldResumeFn = shouldResume;
  shouldWatchdogResumeFn = shouldWatchdogResume ?? shouldResume;
  shouldKeepBgSessionAliveFn = shouldKeepBgSessionAlive ?? null;
  onPauseSessionHeartbeatFn = onPauseSessionHeartbeat ?? null;
  resumeFn = resumePlayback;
  prepareBackgroundFn = prepareForBackground ?? null;
  restoreAudioFn = restoreAudioOnForeground ?? null;

  document.addEventListener("visibilitychange", () => {
    // #region agent log
    debugBg("H4", "background-audio.js:visibilitychange", "visibility", {
      state: document.visibilityState,
      shouldResume: Boolean(shouldResumeFn?.()),
    });
    // #endregion
    if (document.visibilityState === "hidden") {
      onEnterBackground();
      return;
    }
    onReturnToForeground();
  });

  window.addEventListener("blur", () => {
    if (document.visibilityState === "hidden") onEnterBackground();
  });

  window.addEventListener("focus", () => {
    onReturnToForeground();
  });

  window.addEventListener("pagehide", (e) => {
    const shouldResume = Boolean(shouldResumeFn?.());
    // #region agent log
    debugBg("H-78", "background-audio.js:pagehide", "pagehide-background-guard", {
      persisted: e.persisted,
      shouldResume,
      visibility: document.visibilityState,
    });
    // #endregion
    if (shouldResume) onEnterBackground();
  });

  window.addEventListener("pageshow", () => {
    onReturnToForeground();
  });

  document.addEventListener("freeze", () => {
    if (shouldResumeFn?.()) startBackgroundKeepAlive();
  });

  document.addEventListener("resume", () => {
    onReturnToForeground();
  });

  if ("wakeLock" in navigator) {
    document.addEventListener("visibilitychange", async () => {
      if (document.visibilityState === "visible" && shouldResumeFn?.()) {
        await requestWakeLock();
      }
    });
  }
}

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "sw-updated") location.reload();
  });
  const version = document.querySelector('script[src*="app.js"]')?.src.match(/[?&]v=([^&]+)/)?.[1];
  const swUrl = version ? `sw.js?v=${version}` : "sw.js";
  navigator.serviceWorker.register(swUrl).catch(() => {});
}
