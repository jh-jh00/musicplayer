import {
  exportStateForSync,
  importStateFromSync,
  getState,
  getOwnerUid,
  setOwnerUid,
  resetLocalLibrary,
  ensureDefaultPlaylist,
  subscribe,
} from "./playlists.js";
import { isConfigured, getUser, pullRemoteState, pushRemoteState } from "./auth.js";

let pushTimer;
let pushQueue = Promise.resolve();
let loginRequest;
let syncUid;
let revision;
let generation = 0;
let suppress = false;

async function writeState(uid, expectedGeneration) {
  if (syncUid !== uid || getUser()?.uid !== uid || generation !== expectedGeneration) return false;
  try {
    const result = await pushRemoteState({ ...exportStateForSync(), syncUid: uid }, revision);
    if (generation !== expectedGeneration) return false;
    revision = result.updatedAt;
    return true;
  } catch {
    if (generation === expectedGeneration) syncUid = undefined;
    return false;
  }
}

export function scheduleSyncPush() {
  const uid = getUser()?.uid;
  if (suppress || !uid || syncUid !== uid) return;
  const expectedGeneration = generation;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushQueue = pushQueue.then(() => writeState(uid, expectedGeneration));
  }, 900);
}

async function loadForSync(uid, expectedGeneration) {
  if (getOwnerUid() && getOwnerUid() !== uid) resetLocalLibrary(uid);

  let remote;
  try {
    remote = await pullRemoteState();
  } catch {
    return "sync_paused";
  }
  if (getUser()?.uid !== uid || generation !== expectedGeneration) return "sync_paused";
  if (remote !== null && !Number.isSafeInteger(remote?.updatedAt)) return "sync_paused";

  suppress = true;
  try {
    if (remote === null) {
      if (getOwnerUid() !== uid) resetLocalLibrary(uid);
      ensureDefaultPlaylist();
    } else {
      setOwnerUid(uid);
      importStateFromSync(remote);
    }
  } finally {
    suppress = false;
  }

  syncUid = uid;
  revision = remote?.updatedAt ?? null;
  if (remote === null || getState().uiTheme !== (remote.uiTheme || "default")) {
    return (await writeState(uid, expectedGeneration)) ? "synced" : "sync_paused";
  }
  return "downloaded";
}

export async function syncOnLogin() {
  const uid = getUser()?.uid;
  if (!isConfigured() || !uid) return;
  if (loginRequest?.uid === uid) return loginRequest.promise;
  clearTimeout(pushTimer);
  syncUid = undefined;
  const expectedGeneration = ++generation;
  const promise = loadForSync(uid, expectedGeneration);
  loginRequest = { uid, promise };
  try {
    return await promise;
  } finally {
    if (loginRequest?.promise === promise) loginRequest = undefined;
  }
}

export async function syncOnLogout() {
  clearTimeout(pushTimer);
  generation += 1;
  syncUid = undefined;
  loginRequest = undefined;
  resetLocalLibrary(null);
}

export function hookAutoSync() {
  subscribe(() => scheduleSyncPush());
}

export function getSyncLabel() {
  if (!isConfigured()) return "OAuth 미설정 (로컬만)";
  const uid = getUser()?.uid;
  if (!uid) return "로그인하면 Cloudflare D1 동기화";
  return syncUid === uid ? "클라우드 동기화 활성" : "클라우드 동기화 일시 중지";
}
