import { withdrawAccount } from "./auth.js";
import { syncOnLogout } from "./sync.js";
import { resetLocalLibrary } from "./playlists.js";

export const WITHDRAW_PHRASE = "위 내용을 모두 이해했습니다";

let bound = false;

function $(id) {
  return document.getElementById(id);
}

function setSubmitEnabled() {
  const input = $("withdrawConfirmInput");
  const btn = $("withdrawSubmit");
  if (!input || !btn) return;
  btn.disabled = input.value !== WITHDRAW_PHRASE;
}

function getWithdrawPhraseText() {
  return $("withdrawPhraseText")?.textContent?.trim() || WITHDRAW_PHRASE;
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}

  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, ta.value.length);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

export function openWithdrawModal() {
  const modal = $("withdrawModal");
  if (!modal) return;
  const input = $("withdrawConfirmInput");
  const err = $("withdrawError");
  if (input) input.value = "";
  err?.classList.add("hidden");
  setSubmitEnabled();
  modal.classList.remove("hidden");
  input?.focus();
}

export function closeWithdrawModal() {
  $("withdrawModal")?.classList.add("hidden");
}

export function bindWithdrawUI({ onDone, onToast }) {
  if (bound) return;
  bound = true;

  $("withdrawConfirmInput")?.addEventListener("input", setSubmitEnabled);
  $("withdrawCopyPhrase")?.addEventListener("click", async () => {
    const phrase = getWithdrawPhraseText();
    const input = $("withdrawConfirmInput");
    const copied = await copyText(phrase);
    if (input) {
      input.value = phrase;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    }
    onToast?.(copied ? "복사했습니다" : "확인 문장을 입력했습니다");
  });
  $("withdrawCancel")?.addEventListener("click", closeWithdrawModal);
  $("withdrawModal")?.addEventListener("click", (e) => {
    if (e.target === $("withdrawModal")) closeWithdrawModal();
  });

  $("withdrawSubmit")?.addEventListener("click", async () => {
    const input = $("withdrawConfirmInput");
    const err = $("withdrawError");
    if (!input || input.value !== WITHDRAW_PHRASE) {
      err.textContent = "확인 문장이 일치하지 않습니다.";
      err?.classList.remove("hidden");
      return;
    }

    const btn = $("withdrawSubmit");
    btn.disabled = true;
    err?.classList.add("hidden");

    try {
      await withdrawAccount(input.value);
      closeWithdrawModal();
      await syncOnLogout();
      resetLocalLibrary(null);
      onToast?.("계정이 삭제되었습니다.");
      onDone?.();
    } catch (e) {
      const msg =
        e.message === "invalid_confirmation"
          ? "확인 문장이 일치하지 않습니다."
          : "계정 삭제에 실패했습니다. 잠시 후 다시 시도해 주세요.";
      if (err) {
        err.textContent = msg;
        err.classList.remove("hidden");
      }
      setSubmitEnabled();
    }
  });

  $("btnOpenWithdraw")?.addEventListener("click", openWithdrawModal);
  $("gateWithdrawBtn")?.addEventListener("click", openWithdrawModal);
}

export function setWithdrawVisible(visible) {
  $("btnOpenWithdraw")?.classList.toggle("hidden", !visible);
}
