import { debugBg } from "./debug-log.js";

let handlers = null;

function setActionHandlerSafely(action, handler) {
  try {
    navigator.mediaSession.setActionHandler(action, handler);
  } catch {
    // 일부 브라우저/WebView는 Media Session 객체는 제공하지만 특정 액션을
    // 지원하지 않는다. 선택 기능 하나 때문에 앱 전체 초기화를 멈추지 않는다.
  }
}

export function initMediaSession(h) {
  handlers = h;
  if (!("mediaSession" in navigator)) return;

  setActionHandlerSafely("play", () => {
    // #region agent log
    debugBg("H15", "media-session.js:onPlay", "mediasession-play-fired", {
      visibility: document.visibilityState,
      playbackState: navigator.mediaSession.playbackState,
    });
    // #endregion
    handlers?.onPlay?.();
  });
  setActionHandlerSafely("pause", () => {
    // #region agent log
    debugBg("H11", "media-session.js:onPause", "mediasession-pause-fired", {
      visibility: document.visibilityState,
      playbackState: navigator.mediaSession.playbackState,
    });
    // #endregion
    handlers?.onPause?.();
  });
  setActionHandlerSafely("previoustrack", () => handlers?.onPrev?.());
  setActionHandlerSafely("nexttrack", () => handlers?.onNext?.());
}

export function updateMediaSession({ title, artist, art, playing, appPlaying = playing, systemPlaying = playing, virtualPause = false, silentPrimary = false, silentMsPlaying = false }) {
  if (!("mediaSession" in navigator)) return;

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: title || "Playlist Player",
      artist: artist || "",
      album: "Playlist Player",
      artwork: art
        ? [
            { src: art, sizes: "96x96", type: "image/jpeg" },
            { src: art, sizes: "256x256", type: "image/jpeg" },
            { src: art, sizes: "512x512", type: "image/jpeg" },
          ]
        : [],
    });
    const playbackState = systemPlaying ? "playing" : "paused";
    navigator.mediaSession.playbackState = playbackState;
    // #region agent log
    debugBg("H-Y", "media-session.js:updateMediaSession", "mediasession-state-set", {
      playbackState,
      systemPlaying,
      playing,
      appPlaying,
      virtualPause,
      silentPrimary,
      silentMsPlaying,
      visibility: document.visibilityState,
    });
    if (silentMsPlaying) {
      debugBg("H-43", "media-session.js:updateMediaSession", "silent-ms-playing", {
        playbackState,
        systemPlaying,
        appPlaying,
      });
    }
    // #endregion
  } catch {}
}

export function updateMediaPosition({ duration, position, rate = 1 }) {
  if (!("mediaSession" in navigator)) return;
  if (!duration || duration < 1) return;
  if (typeof navigator.mediaSession.setPositionState !== "function") return;

  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: rate,
      position: Math.min(Math.max(0, position || 0), duration),
    });
  } catch {}
}
