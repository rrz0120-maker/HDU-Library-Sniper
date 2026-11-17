import { ORIGIN } from "../core.js";

const PHASES = {
  IDLE: ["162 · 待启动", "idle"],
  PREPARING: ["正在检查", "active"],
  READY_READ_ONLY: ["只读检查通过", "active"],
  WAITING: ["162 · 待命", "active"],
  SUBMITTING: ["162 · 提交中", "active"],
  VERIFYING: ["162 · 正在核对", "active"],
  SUCCESS: ["162 · 已成功", "success"],
  FAILED: ["失败 · 手动接管", "failed"],
  UNKNOWN: ["结果待确认", "unknown"],
  STOPPED: ["已停止", "stopped"],
  EXPIRED: ["今日窗口已结束", "stopped"],
};
const REASONS = {
  PREPARE_TOO_EARLY: "未到19:58。可先取消勾选做只读检查；到时需再次点击启动，不会自动开始。",
  READ_ONLY_DEFAULT: "默认只读；每天需重新授权。",
  REHEARSAL_PASSED: "只读检查通过，没有提交预约。",
  ARMED_FOR_2000: "已正式待命。保持前台、屏幕唤醒和网络正常。",
  HTTP_HEADERS: "HTTP响应已到达，正在解析业务结果。",
  SERVER_SUCCESS: "162 · 已受理，正在核验",
  RECORD_VERIFIED: "官方记录已核验：四楼162，08:00—22:00。",
  REVIEW_SAVED_RESULT: "显示已保存的官方核验结果；首次核验时间保持不变。",
  SEAT_UNAVAILABLE: "馆方拒绝：座位不可预约。需要核对记录后才能判定最终失败。",
  NOT_OPEN: "馆方拒绝：日期或时段未开放。不重发。",
  EXISTING: "已有预约或馆方拒绝重复预约。",
  LIMITED: "馆方限流或拒绝访问，自动请求已停止。",
  AUTH_REQUIRED: "登录已失效，请在官网正常认证。本任务不自动恢复。",
  P52_RECEIPT_REQUIRED: "缺少同浏览器、同账号的P5.2成功凭据。不要清除或伪造旧数据。",
  P53_SLOT_FROZEN: "P5.3固定时段已冻结，P6不会重新提交该任务。",
  LEGACY_UNKNOWN: "P5.3仍有未决提交，请核对旧版本与官方记录。禁止通过升级重新预约。",
  PREVIOUS_UNKNOWN: "还有往日未决提交。请在近期任务中查看结果；不能靠跨日解除保护。",
  USER_STOPPED: "已停止后续自动写入。停止不等于撤销预约。",
  FOREGROUND_REQUIRED: "页面离开前台，已停止；不会自动恢复。",
  RECORD_NOT_VERIFIED: "结果待确认，请检查官方预约。不重新提交。",
  HTTP_404: "预约或查询接口返回404。若已提交，结果待确认；不重发。",
  TIMEOUT: "请求超时，服务器可能已经处理，请核对官方预约。",
  NETWORK_ERROR: "网络异常，结果待确认，不重发。",
  TASK_ALREADY_RESERVED: "已存在该任务，仅恢复查看，不重新启动或提交。",
  NO_FORMAL_TASK: "尚无本日正式任务。",
  TODAY_AUTHORIZATION_REQUIRED: "请核对并重新授权当前北京时间日期的任务。",
  CLOCK_UNVERIFIED: "馆方时间样本无法验证，禁止提交。请检查手机自动校时。",
  CLOCK_CHANGED_OR_STALE: "校时样本过期或时间发生变化，已停止。",
  MISSED_WINDOW: "已错过安全执行窗口，不补发。",
  PREPARE_WINDOW: "正式准备仅限北京时间19:58至20:00前；其他时间可只读检查。",
};
export function mountPanel(actions) {
  const host = document.createElement("div");
  host.id = "hdu-p60-host";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    :host{all:initial;position:fixed;right:8px;bottom:12px;z-index:2147483647;font:14px/1.45 system-ui,sans-serif;color:#142d3c}
    *{box-sizing:border-box}[hidden]{display:none!important}button,input,select,textarea{font:inherit}button{min-height:44px;padding:8px 12px;border:1px solid #a5b7c1;border-radius:9px;background:#f8fafc;color:#142d3c;touch-action:manipulation}button:disabled{opacity:.55}
    #toggle{float:right;max-width:calc(100vw - 16px);background:#174e68;color:white;font-weight:600;font-size:14px}
    #toggle[data-tone=success]{background:#17633b}#toggle[data-tone=failed]{background:#a0212b}#toggle[data-tone=unknown]{background:#945008}#toggle[data-tone=stopped]{background:#59646b}
    #panel{clear:both;width:min(344px,calc(100vw - 16px));max-height:68vh;overflow:auto;background:#fff;border:1px solid #a5b7c1;border-radius:12px;padding:12px;margin-bottom:6px;box-shadow:0 3px 16px #0003;overflow-wrap:anywhere}
    h2{font-size:17px;margin:0 0 6px}p{margin:6px 0}small{display:block;color:#46606e}label{display:flex;gap:8px;margin:10px 0}input{width:22px;height:22px;flex-shrink:0}#actions{display:grid;grid-template-columns:1fr 1fr;gap:6px}#start{grid-column:span 2;background:#174e68;color:white}#state{font-weight:600}summary{padding:10px 0;min-height:44px}select,textarea{width:100%;min-height:44px}textarea{height:170px;white-space:pre-wrap;font:12px/1.4 monospace}a{color:#174e68}#recentLabel{display:block}#logStatus{font-size:12px}
  </style>
  <section id="panel" hidden aria-label="P6.0 Lite每日预约"><h2>P6.0 Lite · 四楼162</h2>
    <p id="target"></p><small>08:00—22:00 · 14小时 / 50400秒 / 1人</small>
    <p id="clock"></p><p id="state" role="status" aria-live="polite">未启动</p><small id="reason"></small>
    <label><input type="checkbox" id="authorize"><span id="authLabel"></span></label>
    <div id="actions"><button id="start">启动今日抢座</button><button id="stop">停止任务</button><button id="review">查看结果</button></div>
    <small>未勾选＝只读演练。保持前台和屏幕唤醒；收起面板不会停止任务。</small>
    <p><a href="${ORIGIN}/#!/Seat/Index/myBookingList" target="_blank" rel="noopener noreferrer">官方我的预约</a><span id="manualWrap" hidden> · <a id="manual" href="${ORIGIN}/#!/Space/Category/list">官网手动选座</a></span></p>
    <details id="diagnostics"><summary>诊断日志与近期任务</summary>
      <label id="recentLabel">查看范围<select id="recent"><option value="">今日任务</option></select></label>
      <button id="copy">复制脱敏日志</button><p id="logStatus"></p><textarea id="logText" readonly hidden aria-label="脱敏JSON日志"></textarea>
    </details>
  </section><button id="toggle" aria-expanded="false" data-tone="idle">162 · 待启动</button>`;
  const el = (id) => root.getElementById(id);
  let view,
    engine,
    displaySignature = "",
    authDay = "",
    frameRevision = 0,
    destroyed = false;
  const attach = () => {
    if (!destroyed && location.origin === ORIGIN && !host.isConnected) document.documentElement?.append(host);
  };
  attach();
  // Restore only this existing host and closure. Never initialize an engine or
  // call prepare from a MutationObserver. No errors are inferred from page text.
  const observer = new MutationObserver(() => {
    if (host.isConnected || destroyed || location.origin !== ORIGIN) return;
    attach();
    actions.observe("UI_REATTACHED");
  });
  observer.observe(document, { childList: true, subtree: true });
  const trusted = (fn) => (event) => {
    if (event.isTrusted) void fn();
  };
  el("toggle").onclick = trusted(() => {
    el("panel").hidden = !el("panel").hidden;
    el("toggle").setAttribute("aria-expanded", String(!el("panel").hidden));
  });
  el("start").onclick = trusted(() => actions.start(el("authorize").checked, authDay));
  el("stop").onclick = trusted(() => actions.stop());
  el("review").onclick = trusted(() => actions.review(el("recent").value));
  el("manual").onclick = (event) => {
    if (view?.state !== "FAILED") {
      event.preventDefault();
      el("reason").textContent = "仅在明确失败后人工选座；结果未知时请先检查官方预约。";
    } else {
      el("panel").hidden = true;
      el("toggle").setAttribute("aria-expanded", "false");
    }
  };
  const showLogs = async (copy) => {
    try {
      const value = JSON.stringify(await actions.export(), null, 2);
      el("logText").value = value;
      if (copy && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(value);
          el("logStatus").textContent = "脱敏日志已复制";
          return;
        } catch {
          /* Native selectable text fallback, no permissions required. */
        }
      }
      el("logText").hidden = false;
      el("logText").focus();
      el("logText").select();
      el("logStatus").textContent = "请长按日志文本，全选并复制。";
    } catch {
      el("logStatus").textContent = "日志读取失败；不影响已保存的提交保护。";
    }
  };
  el("copy").onclick = trusted(() => showLogs(true));
  el("diagnostics").ontoggle = () => {
    if (el("diagnostics").open) void actions.recent();
  };
  return {
    root,
    host,
    newDay(task) {
      authDay = task.day;
      el("authorize").checked = false;
      el("authorize").disabled = false;
      el("recent").replaceChildren(new Option("今日任务", ""));
      el("authLabel").textContent = `我确认馆方规则及上述方案，授权 ${task.day} 今日最多一次提交。`;
    },
    recent(rows) {
      const previous = el("recent").value;
      el("recent").replaceChildren(
        new Option("今日任务", ""),
        ...rows.map((r) => new Option(`${r.target.date} · ${r.state}`, r.target.day)),
      );
      if ([...el("recent").options].some((o) => o.value === previous)) el("recent").value = previous;
    },
    render(next, source) {
      view = next;
      engine = source;
      const historical = next.task.day !== authDay;
      el("authorize").disabled = historical || next.formal || next.state === "PREPARING";
      el("start").disabled = historical || next.formal || next.state === "PREPARING";
      if (historical) el("authorize").checked = false;
      el("target").textContent =
        `${next.task.day === authDay ? "今日" : "历史只读"}任务 ${next.task.day} → 预约 ${next.task.date}`;
      const phase = next.reason === "SERVER_SUCCESS" && next.state === "VERIFYING" ? "ACCEPTED" : next.state;
      const signature = `${next.task.day}:${phase}:${next.reason}`;
      if (signature === displaySignature) return;
      displaySignature = signature;
      const started = performance.now(),
        stateUpdatedAt = new Date().toISOString();
      const [label, tone] = PHASES[next.state] || PHASES.UNKNOWN;
      const text = phase === "ACCEPTED" ? "162 · 已受理，正在核验" : label;
      el("toggle").textContent = next.task.day === authDay ? text : `${next.task.date.slice(5)} · ${label}`;
      el("toggle").dataset.tone = tone;
      el("state").textContent = text;
      el("reason").textContent = REASONS[next.reason] || `状态代码：${next.reason}。不会重发预约。`;
      el("manualWrap").hidden = next.state !== "FAILED";
      const domEnd = performance.now(),
        domUpdatedAt = new Date().toISOString();
      source.recordUI(phase, { stateUpdatedAt, domUpdatedAt, domUpdateMs: domEnd - started });
      const revision = ++frameRevision;
      requestAnimationFrame(() => {
        if (revision !== frameRevision || engine !== source || document.visibilityState !== "visible") return;
        source.recordUI(phase, {
          renderOpportunityAt: new Date().toISOString(),
          renderOpportunityDelayMs: performance.now() - domEnd,
        });
      });
    },
    clock(task, now) {
      const remaining = Math.max(0, Math.ceil((task.open - now) / 1000));
      const countdown = `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`;
      const text = `北京时间20:00 · ${remaining ? `剩余 ${countdown}` : "已到开放时点"}`;
      if (el("clock").textContent !== text) el("clock").textContent = text;
      if (view?.state === "WAITING" && view.task.day === authDay) {
        const label = `162 · ${countdown}`;
        if (el("toggle").textContent !== label) el("toggle").textContent = label;
      }
    },
    destroy() {
      destroyed = true;
      observer.disconnect();
      host.remove();
    },
  };
}
