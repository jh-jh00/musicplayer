import { initAuth, getUser, signInWithGoogle, isConfigured } from "./auth.js";
import { refreshAccess, getAccessState } from "./access.js";
import { debugBg } from "./debug-log.js";

const $ = (id) => document.getElementById(id);
const api = (path, opts = {}) => fetch(path, { credentials: "include", ...opts });

const STATUS_LABEL = {
  unused: "미사용",
  active: "이용 중",
  expired: "만료",
};

const QUICK_ADJUST = [
  { label: "−1시간", minutes: -60 },
  { label: "−1일", days: -1 },
  { label: "+1시간", minutes: 60 },
  { label: "+1일", days: 1 },
  { label: "+7일", days: 7 },
];

function fmtExpiry(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function toDatetimeLocalValue(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

async function copyCode(code) {
  if (await copyText(code)) {
    toast("코드 복사됨");
    return;
  }
  alert("복사에 실패했습니다. 코드를 길게 눌러 직접 선택해 주세요.");
}

function bindCodeCopy(el, code) {
  if (!el) return;
  el.addEventListener("click", () => copyCode(code));
}

async function loadCodes() {
  const res = await api("api/admin/codes");
  if (!res.ok) throw new Error("목록을 불러올 수 없습니다.");
  const data = await res.json();
  return data.codes || [];
}

async function loadFeedbackReports() {
  const res = await api("api/admin/feedback");
  if (!res.ok) throw new Error("feedback_load_failed");
  const data = await res.json();
  return data.reports || [];
}

function renderFeedbackReports(reports) {
  const list = $("feedbackList");
  if (!list) return;
  list.innerHTML = "";
  if (!reports.length) {
    list.innerHTML = `<p class="admin-empty">아직 받은 피드백이 없습니다.</p>`;
    return;
  }
  reports.forEach((report) => {
    const card = document.createElement("article");
    card.className = "admin-feedback-card";
    const head = document.createElement("div");
    head.className = "admin-feedback-head";
    const type = document.createElement("strong");
    type.className = "admin-feedback-type";
    type.textContent = report.type || "feedback";
    const time = document.createElement("span");
    time.className = "admin-feedback-time";
    time.textContent = report.createdAt ? fmtExpiry(report.createdAt) : "";
    head.append(type, time);

    const message = document.createElement("p");
    message.className = "admin-feedback-message";
    message.textContent = report.message || "";

    const meta = document.createElement("dl");
    meta.className = "admin-feedback-meta";
    const payload = report.payload || {};
    [
      ["화면", payload.screen || "-"],
      ["모드", payload.mode || "-"],
      ["재생", payload.playing == null ? "-" : String(payload.playing)],
      ["주소", payload.url || "-"],
    ].forEach(([label, value]) => {
      const row = document.createElement("div");
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = label;
      dd.textContent = value;
      row.append(dt, dd);
      meta.appendChild(row);
    });

    card.append(head, message, meta);
    if (Array.isArray(payload.logs) && payload.logs.length) {
      const logs = document.createElement("details");
      logs.className = "admin-feedback-logs";
      const summary = document.createElement("summary");
      summary.textContent = `로그 ${payload.logs.length}개`;
      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify(payload.logs, null, 2);
      logs.append(summary, pre);
      card.appendChild(logs);
    }
    list.appendChild(card);
  });
}

async function refreshFeedbackReports() {
  try {
    renderFeedbackReports(await loadFeedbackReports());
  } catch {
    const list = $("feedbackList");
    if (list) list.innerHTML = `<p class="admin-empty">피드백을 불러오지 못했습니다.</p>`;
  }
}

function buildAdjustPanel(c) {
  const wrap = document.createElement("div");
  wrap.className = "admin-adjust";

  const quick = document.createElement("div");
  quick.className = "admin-adjust-quick";
  QUICK_ADJUST.forEach((item) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "admin-chip";
    btn.textContent = item.label;
    btn.onclick = () => {
      if (item.minutes != null) adjustCode(c.id, { adjustMinutes: item.minutes });
      else adjustCode(c.id, { adjustDays: item.days });
    };
    quick.appendChild(btn);
  });
  wrap.appendChild(quick);

  const custom = document.createElement("div");
  custom.className = "admin-adjust-custom";
  const amount = document.createElement("input");
  amount.type = "number";
  amount.className = "field-input admin-adjust-amount";
  amount.min = "1";
  amount.value = "1";
  const unit = document.createElement("select");
  unit.className = "field-select admin-adjust-unit";
  unit.innerHTML = `
    <option value="minutes">분</option>
    <option value="hours">시간</option>
    <option value="days" selected>일</option>`;
  const dir = document.createElement("select");
  dir.className = "field-select admin-adjust-dir";
  dir.innerHTML = `
    <option value="add">추가</option>
    <option value="sub">차감</option>`;
  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "btn-text";
  apply.textContent = "적용";
  apply.onclick = () => {
    const n = Number(amount.value);
    if (!Number.isFinite(n) || n <= 0) return;
    const sign = dir.value === "sub" ? -1 : 1;
    const payload = {};
    if (unit.value === "minutes") payload.adjustMinutes = n * sign;
    else if (unit.value === "hours") payload.adjustHours = n * sign;
    else payload.adjustDays = n * sign;
    adjustCode(c.id, payload);
  };
  custom.append(amount, unit, dir, apply);
  wrap.appendChild(custom);

  const exact = document.createElement("div");
  exact.className = "admin-adjust-exact";
  const dt = document.createElement("input");
  dt.type = "datetime-local";
  dt.className = "field-input admin-adjust-datetime";
  if (c.expiresAt) dt.value = toDatetimeLocalValue(c.expiresAt);
  const setBtn = document.createElement("button");
  setBtn.type = "button";
  setBtn.className = "btn-text";
  setBtn.textContent = "만료일 지정";
  setBtn.onclick = () => {
    if (!dt.value) return;
    adjustCode(c.id, { expiresAtIso: dt.value });
  };
  exact.append(dt, setBtn);
  wrap.appendChild(exact);

  if (c.redeemedAt && !c.unlimited) {
    const unlimitedBtn = document.createElement("button");
    unlimitedBtn.type = "button";
    unlimitedBtn.className = "admin-chip admin-chip-accent";
    unlimitedBtn.textContent = "무한으로 변경";
    unlimitedBtn.onclick = () => adjustCode(c.id, { unlimited: true });
    quick.appendChild(unlimitedBtn);
  }

  if (c.expiresAt) {
    const meta = document.createElement("p");
    meta.className = "admin-adjust-meta";
    meta.textContent = `만료: ${fmtExpiry(c.expiresAt)}`;
    wrap.appendChild(meta);
  }

  return wrap;
}

function renderCodes(codes) {
  const list = $("codesList");
  if (!list) return;
  list.innerHTML = "";
  if (!codes.length) {
    list.innerHTML = `<p class="admin-empty">생성된 코드가 없습니다.</p>`;
    return;
  }
  codes.forEach((c) => {
    const card = document.createElement("article");
    card.className = "admin-code-card";
    const userLabel = c.user ? `${c.user.name || c.user.email}` : "—";
    const remainingCell = c.redeemedAt ? c.remainingLabel : "미등록";
    card.innerHTML = `
      <div class="admin-code-head">
        <button type="button" class="admin-code-value" title="탭하여 복사">
          <span class="admin-code-value-text">${c.code}</span>
          <span class="admin-code-copy-hint">탭하여 복사</span>
        </button>
        <span class="admin-badge admin-badge-${c.status}">${STATUS_LABEL[c.status] || c.status}</span>
      </div>
      <dl class="admin-code-meta">
        <div><dt>지급 기간</dt><dd>${c.durationLabel || "—"}</dd></div>
        <div><dt>사용자</dt><dd data-code-user></dd></div>
        <div><dt>남은 기간</dt><dd>${remainingCell}</dd></div>
      </dl>
      <div class="admin-code-foot"></div>`;
    card.querySelector("[data-code-user]").textContent = userLabel;
    bindCodeCopy(card.querySelector(".admin-code-value"), c.code);
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "admin-btn-delete";
    delBtn.textContent = "삭제";
    delBtn.onclick = () => deleteCode(c);
    card.querySelector(".admin-code-foot")?.appendChild(delBtn);
    if (c.redeemedAt) {
      card.appendChild(buildAdjustPanel(c));
    }
    list.appendChild(card);
  });
  // #region agent log
  requestAnimationFrame(() => logAdminLayout("render-codes"));
  // #endregion
}

function toast(msg) {
  let el = document.getElementById("adminToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "adminToast";
    el.className = "admin-toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("is-visible");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("is-visible"), 1600);
}

async function deleteCode(c) {
  const msg = c.redeemedAt
    ? `이용 중인 코드입니다.\n삭제하면 ${c.user?.name || c.user?.email || "사용자"}의 접근이 즉시 끊깁니다.\n정말 삭제할까요?`
    : `미사용 코드 "${c.code}"를 삭제할까요?`;
  if (!confirm(msg)) return;
  const res = await api(`api/admin/codes/${c.id}`, { method: "DELETE" });
  if (!res.ok) {
    alert("삭제에 실패했습니다.");
    return;
  }
  toast("코드 삭제됨");
  await refreshTable();
}

async function adjustCode(id, payload) {
  const res = await api(`api/admin/codes/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.error === "invalid_expires" ? "만료일이 너무 과거입니다." : "기간 조정 실패");
    return;
  }
  await refreshTable();
}

async function refreshTable() {
  const codes = await loadCodes();
  renderCodes(codes);
}

// #region agent log
function logAdminLayout(trigger, runId = "pre-fix") {
  const rect = (sel) => {
    const el = typeof sel === "string" ? document.querySelector(sel) : sel;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      right: Math.round(r.right),
    };
  };
  const styles = (el) => {
    if (!el) return null;
    const s = getComputedStyle(el);
    return { overflow: s.overflow, overflowY: s.overflowY, height: s.height, width: s.width };
  };
  const vw = window.innerWidth;
  const scrollW = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  const data = {
    trigger,
    vw,
    vh: window.innerHeight,
    dpr: window.devicePixelRatio,
    scrollW,
    hasHorizontalOverflow: scrollW > vw + 1,
    scrollH: document.documentElement.scrollHeight,
    bodyScrollH: document.body.scrollHeight,
    clientH: document.documentElement.clientHeight,
    html: styles(document.documentElement),
    body: styles(document.body),
    adminPage: styles(document.querySelector(".admin-page")),
    gateHidden: document.getElementById("adminGate")?.classList.contains("hidden"),
    mainHidden: document.getElementById("adminMain")?.classList.contains("hidden"),
    gate: rect("#adminGate"),
    header: rect(".admin-header"),
    duration: rect(".admin-create-duration"),
    codeHead: rect(".admin-code-head"),
    codeValue: rect(".admin-code-value"),
    badge: rect(".admin-badge"),
    adjustQuick: rect(".admin-adjust-quick"),
    adjustCustom: rect(".admin-adjust-custom"),
    codeCount: document.querySelectorAll(".admin-code-card").length,
  };
  debugBg("layout", "admin.js:logAdminLayout", "admin mobile layout metrics", {
    runId,
    ...data,
  });
}
// #endregion

async function boot() {
  await initAuth();
  const user = getUser();
  const access = await refreshAccess();

  if (!user) {
    $("adminGateMsg").textContent = "관리자 로그인이 필요합니다.";
    $("adminLoginBtn").classList.toggle("hidden", !isConfigured());
    $("adminLoginBtn").onclick = () => signInWithGoogle();
    // #region agent log
    requestAnimationFrame(() => logAdminLayout("boot-gate-unauthenticated"));
    // #endregion
    return;
  }

  if (!access.admin) {
    $("adminGateMsg").textContent = "관리자 권한이 없습니다.";
    // #region agent log
    requestAnimationFrame(() => logAdminLayout("boot-gate-no-admin"));
    // #endregion
    return;
  }

  $("adminGate").classList.add("hidden");
  $("adminMain").classList.remove("hidden");

  const syncCreateDurationFields = () => {
    const on = $("createUnlimited").checked;
    $("createDurationFields")?.classList.toggle("hidden", on);
  };
  $("createUnlimited")?.addEventListener("change", syncCreateDurationFields);
  syncCreateDurationFields();

  $("btnCreateCode").onclick = async () => {
    const unlimited = $("createUnlimited").checked;
    let body = { unlimited: true };
    if (!unlimited) {
      const days = Number($("createDays").value);
      const hours = Number($("createHours")?.value || 0);
      body = { durationDays: days + hours / 24 };
    }
    const res = await api("api/admin/codes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      $("createResult").textContent = "생성 실패";
      return;
    }
    const durationLabel = unlimited
      ? "무한"
      : `${$("createDays").value}일 ${$("createHours").value}시간`;
    $("createResult").innerHTML = `생성됨: <button type="button" class="admin-code-copy-inline">${data.code}</button> (${durationLabel})`;
    bindCodeCopy($("createResult").querySelector(".admin-code-copy-inline"), data.code);
    await refreshTable();
  };

  $("btnRefreshFeedback")?.addEventListener("click", async () => {
    await refreshFeedbackReports();
    toast("피드백 새로고침 완료");
  });

  await refreshTable();
  await refreshFeedbackReports();
  // #region agent log
  requestAnimationFrame(() => logAdminLayout("boot-main-ready"));
  // #endregion
}

// #region agent log
window.addEventListener("resize", () => {
  clearTimeout(logAdminLayout._t);
  logAdminLayout._t = setTimeout(() => logAdminLayout("resize"), 200);
});
// #endregion

boot();
