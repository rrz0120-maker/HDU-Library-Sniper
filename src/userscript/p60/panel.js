import { readHistory } from "./history.js";
import { dailyTask, DEFAULTS, REASONS, STATES, VERIFICATIONS } from "./policy.js";

const PREFS = "hdu-p62:settings";
const hour = (n) => `${String(n).padStart(2, "0")}:00`;
function clock(iso) {
  if (!iso) return "—";
  return new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(11, 23);
}

export function mountPanel(host, engine, legacy) {
  const root = host.attachShadow({ mode: "open" });
  if (legacy) host.dataset.legacy = "true";
  root.innerHTML = [
    "<style>:host{all:initial;position:fixed;right:8px;bottom:max(8px,env(safe-area-inset-bottom));z-index:2147483646;font:14px/1.5 system-ui,sans-serif;color:#233842}",
    ":host([data-legacy]){top:8px;bottom:auto}*{box-sizing:border-box}details{max-width:calc(100vw - 16px);border:1px solid #a1b9b5;border-radius:10px;background:#f9fdfc;box-shadow:0 2px 12px #183c3b2a}details[open]{width:318px}",
    "summary{padding:9px 12px;cursor:pointer;color:#155d50;font-weight:650}.body{padding:0 12px 12px;max-height:67vh;overflow:auto;overscroll-behavior:contain}",
    "label{display:inline-flex;align-items:center;gap:4px}select,input,button,textarea{font:inherit}select,input,button{min-height:38px;color:inherit}input{width:76px}",
    ".row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:7px 0}button{padding:4px 9px;border:1px solid #9db7b0;border-radius:7px;background:#fff;cursor:pointer}",
    "#start{background:#155d50;color:#fff;border-color:#155d50}button:disabled{opacity:.5}p{margin:7px 0}.note{font-size:12px;color:#526b6b}",
    "output{display:block;overflow-wrap:anywhere;white-space:pre-wrap;font-size:12px}textarea{width:100%;height:110px}</style>",
    '<details><summary>P6.4 候选 · 162 · <span id="state" role="status"></span></summary><div class="body">',
    '<p>宋韵云图（四楼）162号</p><p id="target"></p>',
    '<div class="row"><label>开始 <select id="startHour"></select></label><label>结束 <select id="endHour"></select></label></div>',
    '<label>20:00 后 <input id="offset" type="number" min="800" max="2000" step="1" value="1350"> 毫秒</label>',
    '<p class="note">请保持 Firefox 前台和屏幕常亮，开启系统自动校时。</p>',
    '<div class="row"><button id="start">启动正式预约</button><button id="stop">停止待命</button></div>',
    '<output id="reason" aria-live="polite"></output><output id="metrics"></output>',
    '<div class="row"><button id="review">核验官方记录</button><button id="copy">复制诊断日志</button></div>',
    '<span id="copyStatus" role="status"></span><textarea id="log" aria-label="脱敏诊断日志" readonly hidden></textarea>',
    '<button id="history">查看运行历史（含P6.3）</button><div id="archive" hidden><select id="runs" aria-label="历史运行"></select><textarea id="snapshot" readonly aria-label="历史诊断"></textarea><button id="copyHistory">复制所选 JSON</button></div>',
    "</div></details>",
  ].join("");
  const el = (id) => root.getElementById(id);
  for (let n = 7; n <= 22; n++) {
    if (n < 22) el("startHour").add(new Option(hour(n), n));
    if (n > 7) el("endHour").add(new Option(hour(n), n));
  }
  let settings = DEFAULTS;
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS));
    if (saved && [saved.startHour, saved.endHour, saved.offsetMs].every(Number.isInteger)) {
      dailyTask(Date.now(), saved);
      settings = saved;
    }
  } catch {
    /* Settings are optional. */
  }
  el("startHour").value = settings.startHour;
  el("endHour").value = settings.endHour;
  el("offset").value = settings.offsetMs;
  let shownDay;
  function selection() {
    return dailyTask(Date.now(), {
      startHour: +el("startHour").value,
      endHour: +el("endHour").value,
      offsetMs: +el("offset").value,
    });
  }
  function preview() {
    try {
      const task = selection();
      shownDay = task.day;
      el("target").textContent = `预约 ${task.date}　${hour(task.startHour)}–${hour(task.endHour)}`;
      el("start").disabled = engine.running || legacy;
      return task;
    } catch (error) {
      el("target").textContent = REASONS[error.code] || REASONS.INVALID_TIME;
      el("start").disabled = true;
    }
  }
  function render(view) {
    el("state").textContent = legacy
      ? "检测到旧版"
      : view.historical
        ? "未启动 · 上次 " + STATES[view.state]
        : STATES[view.state];
    el("reason").textContent =
      (legacy
        ? REASONS.LEGACY_ACTIVE
        : view.recordVerified
          ? REASONS.RECORD_VERIFIED
          : REASONS[view.reason]) +
      (view.diagnosticStorageFailed ? "\n诊断存储异常，建议复制日志。" : "") +
      (view.message ? `\n${view.message}` : "") +
      (view.inWindow === false ? "\n已超出准点窗口。页面暂停或主线程延迟可能推迟请求。" : "");
    el("metrics").textContent = view.date
      ? [
          `本次 ${view.date}　${hour(view.startHour)}–${hour(view.endHour)}`,
          `计划 ${clock(view.plannedAt)}　发出 ${clock(view.dispatchAt)}`,
          `相对20:00 ${view.delayFrom20Ms ?? "—"} ms　发送 ${view.attempts ?? "未知"} 次`,
          `HTTP ${view.httpStatus ?? "—"}　${view.httpMs == null ? "—" : `${Math.round(view.httpMs)} ms`}`,
          `响应 ${clock(view.responseAt)}　业务码 ${view.businessCode ?? "—"}`,
          `服务器受理 ${view.accepted ? "是" : "未确认"}　${view.reason}`,
          `最近核验 ${VERIFICATIONS[view.verification]}`,
          view.nextWriteAt ? `最早再次申请 ${clock(view.nextWriteAt)}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      : "";
    for (const id of ["startHour", "endHour", "offset"]) el(id).disabled = view.running;
    el("start").disabled = view.running || legacy || !shownDay;
    el("history").disabled = view.running;
    el("stop").disabled = !view.running || view.reviewing || view.attempts !== 0;
    el("review").disabled = view.running || !["UNKNOWN", "ACCEPTED", "SUCCESS"].includes(view.state);
  }
  for (const id of ["startHour", "endHour", "offset"]) el(id).oninput = preview;
  root.querySelector("details").ontoggle = () => {
    if (!engine.running) preview();
  };
  el("start").onclick = () => {
    const previousDay = shownDay;
    const task = preview();
    if (!task || engine.running || legacy) return;
    if (previousDay !== shownDay) {
      el("target").append("　日期已更新，请核对后启动。");
      return;
    }
    try {
      localStorage.setItem(
        PREFS,
        JSON.stringify({ startHour: task.startHour, endHour: task.endHour, offsetMs: task.offsetMs }),
      );
    } catch {
      /* Settings are optional. */
    }
    el("copyStatus").textContent = "";
    el("log").hidden = true;
    void engine.prepare(task);
  };
  el("stop").onclick = () => engine.stop();
  el("review").onclick = () => void engine.review();
  el("history").onclick = () => {
    try {
      const rows = readHistory();
      const runs = el("runs");
      runs.replaceChildren(
        ...rows.map((row, index) => new Option(`${row.prepareStartedAt ?? row.date} · ${row.reason}`, index)),
      );
      runs.onchange = () => {
        el("snapshot").value = JSON.stringify(rows[runs.value], null, 2) ?? "";
      };
      runs.onchange();
      el("archive").hidden = false;
      el("copyHistory").disabled = !rows.length;
      el("copyStatus").textContent = rows.length ? "" : "暂无历史记录";
    } catch {
      el("copyStatus").textContent = "历史诊断读取失败";
    }
  };
  el("copyHistory").onclick = () => copy(el("snapshot").value);
  el("copy").onclick = () => copy(JSON.stringify(engine.diagnosticExport(), null, 2));
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      el("copyStatus").textContent = "已复制";
      el("log").hidden = true;
    } catch {
      el("log").hidden = false;
      el("log").value = text;
      el("log").focus();
      el("log").select();
      el("copyStatus").textContent = "可长按复制所选日志";
    }
  }
  preview();
  return { render };
}
