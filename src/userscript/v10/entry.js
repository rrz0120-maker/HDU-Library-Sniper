import { ORIGIN } from "../core.js";
import { Booking } from "./engine.js";
import { diagnostic, makeTask, REASONS, STATES, VERIFICATIONS } from "./policy.js";

import { history, clearHistory } from "./guard.js";

const hostId = "hdu-ipad-v10-lite";
const legacyIds = [
  "hdu-ipad-v9-lite",
  "hdu-p51-panel",
  "hdu-p53-host",
  "hdu-p60-host",
  "hdu-p70-host",
  "hdu-p71-host",
];

function mount() {
  if (location.origin !== ORIGIN || window !== window.top || document.getElementById(hostId)) return;
  const host = document.createElement("div");
  host.id = hostId;
  const legacy = legacyIds.some((id) => document.getElementById(id));
  if (legacy) host.dataset.legacy = "present";
  // Old releases already check these document IDs before boot. Reserve them only in a clean page.
  // Never patch fetch, XHR, official-page controls or a legacy database.
  if (!legacy) {
    for (const id of legacyIds) {
      const marker = document.createElement("span");
      marker.id = id;
      marker.hidden = true;
      host.append(marker);
    }
  }
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = [
    "<style>:host{all:initial;position:fixed;right:max(8px,env(safe-area-inset-right));bottom:max(8px,env(safe-area-inset-bottom));z-index:2147483000;color:#172c36;font:15px/1.4 system-ui,sans-serif}",
    ":host([data-legacy]){top:max(8px,env(safe-area-inset-top));bottom:auto}",
    "*{box-sizing:border-box}details{max-width:calc(100vw - 16px);background:#fafdfc;border:1px solid #9bb5ae;border-radius:12px;box-shadow:0 3px 14px #132e382b}details[open]{width:332px}",
    "summary{cursor:pointer;padding:10px 13px;color:#164f46;font-weight:650;overflow-wrap:anywhere}.body{padding:0 12px 12px;max-height:65vh;overflow:auto;overscroll-behavior:contain}",
    "label{display:inline-flex;align-items:center;gap:4px}select,input,button,textarea{font:inherit;color:inherit}input{width:80px}select,input,button{min-height:36px}",
    "button{cursor:pointer;border:1px solid #a4b9b2;border-radius:7px;background:#fff;padding:4px 9px}button:disabled{opacity:.5}#start{background:#155c50;color:white;border-color:#155c50}",
    ".row{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin:6px 0}p{margin:6px 0}.note{font-size:13px;color:#486059}output{display:block;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}textarea{width:100%;height:95px}</style>",
    '<details><summary>V10.0 · 162 · <span id="status" role="status"></span></summary><div class="body">',
    '<p>宋韵云图（四楼） · 162 号</p><label>模式 <select id="mode"><option value="scheduled">整点预约</option><option value="now">已开放时段测试</option></select></label>',
    '<div class="row"><label>开始 <select id="from"></select></label><label>结束 <select id="to"></select></label></div>',
    '<label id="offsetRow">20:00 后 <input type="number" min="800" max="2000" step="1" id="offset" value="1200"> 毫秒</label>',
    '<p id="target"></p><p class="note">请保持 Safari 前台、屏幕常亮，并开启系统自动校时。</p>',
    '<div class="row"><button id="start"></button><button id="stop">停止</button></div>',
    '<output id="feedback" aria-live="polite"></output><output id="metrics"></output>',
    '<div class="row"><button id="review">核验官方记录</button><button id="copy">复制诊断日志</button></div>',
    '<span id="copied" role="status"></span><textarea id="log" aria-label="诊断日志" readonly hidden></textarea>',
    '<div class="row"><button id="history">最近 30 次运行</button></div>',
    '<section id="archive" hidden><label>历史记录 <select id="runs"></select></label><textarea id="snapshot" readonly aria-label="历史诊断"></textarea><div class="row"><button id="copyHistory">复制此记录</button><button id="reviewHistory">核验此记录</button><button id="clearHistory">清空历史</button></div></section>',
    '<output id="storage" role="status"></output></div></details>',
  ].join("");
  document.body.append(host);
  const el = (id) => root.getElementById(id);
  const details = root.querySelector("details");
  const fmtHour = (hour) => `${String(hour).padStart(2, "0")}:00`;
  for (let hour = 7; hour <= 22; hour++) {
    if (hour < 22) el("from").add(new Option(fmtHour(hour), hour));
    if (hour > 7) el("to").add(new Option(fmtHour(hour), hour));
  }
  let prefs;
  try {
    prefs = JSON.parse(localStorage.getItem("hdu-v9:settings"));
  } catch {
    /* defaults */
  }
  try {
    if (![prefs.start, prefs.end, prefs.offset].every(Number.isInteger)) throw new Error();
    makeTask("scheduled", Date.now(), prefs.start, prefs.end, prefs.offset);
  } catch {
    prefs = { start: 9, end: 22, offset: 1200 };
  }
  el("from").value = prefs.start;
  el("to").value = prefs.end;
  el("offset").value = prefs.offset;
  const booking = new Booking(render, legacy);
  let shownDate;
  function selection() {
    return makeTask(el("mode").value, Date.now(), +el("from").value, +el("to").value, +el("offset").value);
  }
  function preview() {
    el("offsetRow").style.display = el("mode").value === "scheduled" ? "" : "none";
    el("start").textContent = el("mode").value === "now" ? "立即真实预约" : "启动 20:00 预约";
    try {
      const task = selection();
      shownDate = task.date;
      el("target").textContent = `预约 ${task.date}　${fmtHour(task.start)}–${fmtHour(task.end)}`;
      el("start").disabled = !!booking.active || legacy;
      return task;
    } catch (error) {
      shownDate = null;
      el("target").textContent = REASONS[error.code] || "请检查设置";
      el("start").disabled = true;
    }
  }
  function render(r, detail, run) {
    if (r.storageStatus === "ERROR") storageWarning();
    el("status").textContent = legacy ? "检测到旧版" : (run || !r.date ? "" : "上次 · ") + STATES[r.state];
    const warning = r.inWindow === false ? "\n超出准点窗口；前台主线程延迟或系统暂停均可能推迟发送。" : "";
    el("feedback").textContent =
      (legacy ? `${REASONS.LEGACY}\n` : "") +
      (r.state === "idle" && r.result === "IDLE" ? "" : r.reason) +
      (detail ? `\n${detail}` : "") +
      warning;
    const time = (stamp) => (stamp ? stamp.slice(11, 23) : "—");
    el("metrics").textContent = r.date
      ? [
          `本次 ${r.date}　${fmtHour(r.start)}–${fmtHour(r.end)}`,
          `计划 ${time(r.plannedAt)}　发出 ${time(r.dispatchAt)}`,
          "相对开放 " +
            (r.delayFrom20Ms == null ? "—" : `${r.delayFrom20Ms} ms`) +
            "　实际发送 " +
            (r.sends ?? "未知"),
          `响应 ${time(r.responseAt)}　${r.httpMs == null ? "—" : `${r.httpMs} ms`}`,
          `HTTP ${r.httpStatus ?? "—"}　业务码 ${r.businessCode ?? "—"}　${r.result}`,
          `官方记录 ${VERIFICATIONS[r.verification]}`,
          r.nextWriteAfter ? `最早可重新申请 ${r.nextWriteAfter.slice(0, 19).replace("T", " ")}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      : "";
    for (const id of ["mode", "from", "to", "offset"]) el(id).disabled = !!run;
    el("start").disabled = !!run || legacy || !shownDate;
    el("stop").disabled = !run || run.dispatched || run.review;
    el("review").disabled = !!run || !["unknown", "accepted", "verified"].includes(r.state);
  }
  for (const id of ["mode", "from", "to", "offset"]) el(id).oninput = preview;
  details.ontoggle = () => {
    if (details.open && !booking.active) preview();
  };
  el("start").onclick = () => {
    const previousDate = shownDate;
    const task = preview();
    if (!task || booking.active || legacy) return;
    if (previousDate !== shownDate) {
      el("target").append("　日期已更新，请确认后启动。");
      return;
    }
    try {
      localStorage.setItem(
        "hdu-v9:settings",
        JSON.stringify({ start: task.start, end: task.end, offset: +el("offset").value }),
      );
    } catch {
      /* optional preferences */
    }
    el("copied").textContent = "";
    el("log").hidden = true;
    void booking.start(task);
  };
  el("stop").onclick = () => booking.stop();
  el("review").onclick = () => void booking.review();
  async function copy(json) {
    try {
      await navigator.clipboard.writeText(json);
      el("copied").textContent = "已复制";
      el("log").hidden = true;
    } catch {
      const box = el("log");
      box.hidden = false;
      box.value = json;
      box.focus();
      box.select();
      el("copied").textContent = "可长按复制所选日志";
    }
  }
  el("copy").onclick = () => copy(JSON.stringify(diagnostic(booking.report), null, 2));
  function storageWarning() {
    el("storage").textContent = "本机日志存储异常，请及时复制诊断。";
  }
  let rows = [];
  function selected() {
    return rows[el("runs").selectedIndex];
  }
  function selectHistory() {
    const r = selected();
    el("snapshot").value = r ? JSON.stringify(r, null, 2) : "暂无历史记录";
    el("copyHistory").disabled = !r;
    el("reviewHistory").disabled =
      !r || !!booking.active || !["unknown", "accepted", "sending", "verified"].includes(r.state);
  }
  function listHistory() {
    try {
      rows = history();
    } catch {
      rows = [];
      storageWarning();
    }
    el("runs").replaceChildren(
      ...rows.map(
        (r) =>
          new Option(
            `${(r.prepareStartedAt || "").slice(5, 19).replace("T", " ")} · ${REASONS[r.result]}`,
            r.runId,
          ),
      ),
    );
    selectHistory();
  }
  el("history").onclick = () => {
    el("archive").hidden = !el("archive").hidden;
    if (!el("archive").hidden) listHistory();
  };
  el("runs").onchange = selectHistory;
  el("copyHistory").onclick = () => {
    if (selected()) void copy(JSON.stringify(selected(), null, 2));
  };
  el("reviewHistory").onclick = async () => {
    if (booking.active || !selected()) return;
    booking.report = diagnostic(selected());
    if (booking.report.state === "sending")
      Object.assign(booking.report, { state: "unknown", result: "PENDING" });
    booking.detail = "";
    await booking.review();
    listHistory();
  };
  el("clearHistory").onclick = () => {
    if (!confirm("清空本机运行历史？未决请求保护继续生效。")) return;
    try {
      clearHistory();
    } catch {
      storageWarning();
    }
    listHistory();
  };
  preview();
  booking.paint();
}
if (document.body) mount();
else document.addEventListener("DOMContentLoaded", mount, { once: true });
