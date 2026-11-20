import { ORIGIN, codeOf, shanghaiDate } from "../core.js";
import { slotSummary } from "../p70/policy.js";
import { P70_MESSAGES } from "../p70/panel.js";
import { scheduledTimeLabel } from "./policy.js";

export const P71_MESSAGES = {
  READ_ONLY_DEFAULT: "默认只读；每天需重新勾选授权。未勾选点击启动可做只读预检。",
  PREPARE_TOO_EARLY: "未到北京时间19:55。可先取消勾选做只读预检；到19:55后需重新勾选并点击启动。",
  PREPARE_WINDOW: "正式准备仅限北京时间19:55至20:00前；其他时间仅支持只读预检。",
  REHEARSAL_PASSED: "只读预检通过（含自定义时段与162映射核验），未提交预约。",
  ARMED_FOR_2000: "已进入20:00待命（19:59:15将自动重校时）。请保持Safari前台与屏幕常亮。",
  RECALIBRATING_CLOCK: "临近20:00，正在自动重新校时...",
  RECALIBRATED_OK: "临近校时通过，继续等待20:00开放门禁。",
  OPEN_RANGE_CHECKING: "20:00门禁已过，正在核对馆方实际可约日期（尚未提交）。",
  OPEN_RANGE_NOT_YET: "馆方尚未列出目标日期，将在安全窗口内间隔1秒后至多再核对一次。",
  OPEN_RANGE_CONFIRMED: "馆方已确认目标日期开放，准备执行唯一一次正式预约。",
  OPEN_RANGE_UNCONFIRMED: "未能确认目标日期已开放，本次未提交预约（0次写入）。请查看官网。",
  SUBMITTING_ONCE: "正在提交唯一一次162预约请求，请保持前台与网络正常。",
  SERVER_SUCCESS: "162 · 馆方已受理，正在核验官方记录...",
  RECORD_VERIFIED: "预约成功：官方记录已核验四楼162与自定义时段完全一致。",
  REVIEW_SAVED_RESULT: "已核验成功的预约记录；首次时间戳保持不变。",
  RECORD_NOT_VERIFIED: "暂未核验到官方记录，请查看官网“我的预约”；绝不自动重发。",
  SEAT_UNAVAILABLE: "馆方拒绝：162号不可预约。不自动换座。",
  NOT_OPEN: "馆方拒绝：目标日期或时段未开放。不重发。",
  EXISTING: "目标时段已有冲突预约，禁止重复提交。",
  LIMITED: "馆方限流或拒绝访问，已停止。",
  AUTH_REQUIRED: "登录已失效，请在官网重新登录。不会自动恢复提交。",
  PREVIOUS_UNKNOWN: "存在往日未决(UNKNOWN)记录，已禁止新预约；请先核验官方记录。",
  CROSS_MODE_ACTIVE_TASK: "普通预约模式正在执行任务，整点模式已互斥阻断。",
  CROSS_MODE_UNKNOWN: "普通预约模式存在未决(UNKNOWN)记录，请先在普通模式核验官方记录。",
  CROSS_MODE_CONFLICT: "另一模式存在冲突任务，已阻止重复操作。",
  TASK_ALREADY_RESERVED: "今日目标日期任务已存在，仅查看不重复启动。",
  NO_FORMAL_TASK: "尚无本日正式整点任务。",
  TODAY_AUTHORIZATION_REQUIRED: "请核对日期并勾选今日明确授权。",
  DURATION_NOT_ALLOWED: "所选自定义时段或时长不符合馆方当前开放规则，请调整开始/结束时间。",
  INVALID_DURATION: "结束时间必须晚于开始时间且为整点小时。",
  CLOCK_UNVERIFIED: "校时样本无法验证，禁止提交。请检查iPad自动日期与时间设置。",
  CLOCK_CHANGED_OR_STALE: "校时样本过期或时钟发生跳变，已停止；不会补发。",
  SAFARI_TIMER_SUSPENDED: "检测到Safari定时器被挂起或锁屏中断，已安全停止；不会恢复补发。",
  MISSED_WINDOW: "已超过20:00:10安全执行窗口，已停止；不补发。",
  FOREGROUND_REQUIRED: "页面离开前台或锁屏，已立即停止；不会自动恢复提交。",
  USER_STOPPED: "已停止后续自动操作。停止不会撤销已发出的预约。",
  HTTP_404: "接口返回404；若已提交则状态待确认，请核验官方记录，不重发。",
  TIMEOUT: "请求超时，服务端可能已处理，请先核验官方记录，不重发。",
  NETWORK_ERROR: "网络异常，结果待确认，请核验官方记录，不重发。",
  STORAGE_UNAVAILABLE: "Safari本地存储不可用，禁止提交。请关闭无痕模式。",
  READ_CHECK_LIMIT_OR_ERROR: "核验次数已达上限(3次)或间隔不足2秒，请直接查看官网“我的预约”。",
  WAITING_VIEW_ONLY: "已存在待命记录（仅查看，本页不恢复提交）。",
  LOGIN_OK: "登录有效。",
  RANGE_OK: "日期规则校验通过。",
};

const P71_PHASES = {
  IDLE: ["162 · 待启动", "idle"],
  PREPARING: ["162 · 预检中", "active"],
  READY_READ_ONLY: ["162 · 预检通过", "active"],
  WAITING: ["162 · 待命", "active"],
  SUBMITTING: ["162 · 提交中", "active"],
  VERIFYING: ["162 · 核验中", "active"],
  SUCCESS: ["162 · 已成功", "success"],
  FAILED: ["162 · 未成功", "failed"],
  UNKNOWN: ["162 · 待核验", "unknown"],
  STOPPED: ["162 · 已停止", "stopped"],
  EXPIRED: ["162 · 窗口结束", "stopped"],
};

export function mountP71Panel(actions, normalEngine) {
  const host = document.createElement("div");
  host.id = "hdu-p71-host";
  const root = host.attachShadow({ mode: "open" });

  const hourOptions = (start, end, selected) => {
    let html = "";
    for (let h = start; h <= end; h++) {
      html += `<option value="${h}"${h === selected ? " selected" : ""}>${String(h).padStart(2, "0")}:00</option>`;
    }
    return html;
  };

  root.innerHTML = `<style>
    :host{all:initial;position:fixed;right:max(12px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#142636;font-size:15px;line-height:1.45}
    *{box-sizing:border-box}[hidden]{display:none!important}
    button,input,select,textarea{font-family:inherit;font-size:16px}
    button,select,input[type=checkbox]{touch-action:manipulation}
    button{min-height:44px;padding:8px 10px;border:1px solid #9db0be;border-radius:10px;background:#fff;color:#142636;cursor:pointer}
    button:disabled{opacity:.5;cursor:default}
    #toggle{float:right;background:#154c79;color:#fff;border:0;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,.22)}
    #toggle[data-tone=success]{background:#17633b}#toggle[data-tone=failed]{background:#a0212b}#toggle[data-tone=unknown]{background:#945008}#toggle[data-tone=stopped]{background:#59646b}
    #panel{clear:both;width:min(410px,calc(100vw - 24px));max-height:min(78vh,calc(100dvh - 88px));overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;background:#f8fafc;border:1px solid #9db0be;border-radius:14px;padding:13px;margin-bottom:8px;box-shadow:0 8px 28px rgba(0,0,0,.2);overflow-wrap:anywhere}
    h2{font-size:17px;margin:0 0 6px}p{margin:5px 0}.hint{font-size:13px;color:#466070}
    .tabs{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:8px 0}
    .tab{min-height:40px;font-weight:600;background:#e8eef3;border-color:#b6c6d3}
    .tab[aria-selected=true]{background:#154c79;color:#fff;border-color:#154c79}
    .box{padding:9px 10px;border-radius:8px;background:#e6f0f8;font-weight:500}
    .grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0}
    .fields{display:grid;gap:8px;margin:8px 0}
    label{display:block;font-size:14px}
    select{width:100%;min-height:44px;margin-top:4px;padding:8px 10px;border:1px solid #94a3b8;border-radius:8px;background:#fff;color:#142636}
    .checkRow{display:flex;gap:8px;align-items:flex-start;margin:8px 0}
    input[type=checkbox]{width:22px;height:22px;flex:none;margin-top:2px}
    .primary{background:#154c79;color:#fff;border:0;font-weight:600}
    .danger{border-color:#a52727;color:#a52727}
    .confirm{margin:8px 0;padding:10px;border:1px solid #cbd5e1;border-radius:10px;background:#fff}
    textarea{width:100%;height:160px;margin-top:6px;padding:8px;border:1px solid #94a3b8;border-radius:8px;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;background:#fff;color:#142636}
    a{color:#154c79;font-weight:500}
  </style>
  <section id="panel" hidden aria-label="P7.1 iPad 预约控制面板">
    <h2>P7.1.1 iPad · 固定162整点 & 普通预约</h2>
    <div class="tabs" role="tablist">
      <button id="tabSched" class="tab" role="tab" aria-selected="true">20:00 整点 162</button>
      <button id="tabNormal" class="tab" role="tab" aria-selected="false">普通预约 (P7.0)</button>
    </div>

    <div id="paneSched">
      <p id="sTarget" style="font-weight:600"></p>
      <p id="sClock" class="hint"></p>
      <div class="grid2">
        <label>开始时间<select id="sStart">${hourOptions(7, 21, 8)}</select></label>
        <label>结束时间<select id="sEnd">${hourOptions(8, 22, 22)}</select></label>
      </div>
      <p id="sDuration" class="hint"></p>
      <p id="sStatus" class="box" role="status" aria-live="polite">${P71_MESSAGES.READ_ONLY_DEFAULT}</p>
      <label class="checkRow"><input type="checkbox" id="sAuth"><span id="sAuthLabel"></span></label>
      <div class="grid2">
        <button id="sStartBtn" class="primary" style="grid-column:span 2">启动20:00待命（未勾选=只读预检）</button>
        <button id="sStopBtn" class="danger">停止任务</button>
        <button id="sReviewBtn">查看官方结果</button>
        <button id="sToggleLog">显示/隐藏日志</button>
        <button id="sCopyLog">复制脱敏日志</button>
      </div>
      <p class="hint">19:55起可正式待命；19:59:15自动重校时。保持Safari前台与屏幕常亮，切后台/锁屏自动中止不补发。</p>
      <p class="hint"><a href="${ORIGIN}/#!/Seat/Index/myBookingList" target="_blank" rel="noopener noreferrer">官方我的预约</a> · <span id="sCopyStatus"></span></p>
      <textarea id="sLogText" readonly hidden aria-label="整点脱敏日志"></textarea>
    </div>

    <div id="paneNormal" hidden>
      <p class="hint">复用 P7.0 普通模式：读取全部房间与当前空余座位，单次 1 小时正常预约。</p>
      <p id="nStatus" class="box" role="status" aria-live="polite">${P70_MESSAGES.READ_ONLY_DEFAULT}</p>
      <div class="grid2"><button id="nLogin">1. 检查登录</button><button id="nDates">2. 读取开放日期</button></div>
      <div class="fields">
        <label>预约日期（北京时间）<select id="nDate"><option value="">请先读取开放日期</option></select></label>
        <label>1小时时段<select id="nHour"><option value="">请先选择日期</option></select></label>
      </div>
      <div class="grid2"><button id="nQuery">3. 查询房间与空位</button><button id="nPrepare" disabled>4. 准备预约方案</button></div>
      <div class="fields">
        <label>选择房间<select id="nRoom" disabled><option value="">请先查询房间与空位</option></select></label>
        <label>当前空余座位<select id="nSeat" disabled><option value="">请先选择房间</option></select></label>
      </div>
      <p id="nRoomMeta" class="hint"></p>
      <div class="confirm">
        <p id="nPreview" style="font-weight:600">尚未准备预约方案</p>
        <label class="checkRow"><input id="nDetails" type="checkbox" disabled><span>确认上述房间、空位、日期与1小时时段。</span></label>
        <label class="checkRow"><input id="nRules" type="checkbox" disabled><span>确认馆方允许本次预约，授权最多1次提交。</span></label>
        <button id="nSubmit" class="primary" style="width:100%" disabled>5. 确认提交一次预约</button>
      </div>
      <div class="grid2">
        <button id="nReview">查看官方结果</button>
        <button id="nStop" class="danger">停止任务</button>
        <button id="nToggleLog">显示/隐藏日志</button>
        <button id="nCopyLog">复制脱敏日志</button>
      </div>
      <p class="hint"><a href="${ORIGIN}/#!/Seat/Index/myBookingList" target="_blank" rel="noopener noreferrer">官方我的预约</a> · <span id="nCopyStatus"></span></p>
      <textarea id="nLogText" readonly hidden aria-label="普通模式脱敏日志"></textarea>
    </div>
  </section>
  <button id="toggle" aria-expanded="false" data-tone="idle">162 · 待启动</button>`;

  const el = (id) => root.getElementById(id);
  let destroyed = false;
  let authDay = "";
  let schedView = null;

  const attach = () => {
    if (!destroyed && location.origin === ORIGIN && !host.isConnected)
      (document.documentElement || document.body)?.append(host);
  };
  attach();
  const observer = new MutationObserver(() => {
    if (!destroyed && location.origin === ORIGIN && !host.isConnected) attach();
  });
  observer.observe(document, { childList: true, subtree: true });

  const trusted = (fn) => (event) => {
    if (event.isTrusted) void fn();
  };

  el("toggle").onclick = trusted(() => {
    el("panel").hidden = !el("panel").hidden;
    el("toggle").setAttribute("aria-expanded", String(!el("panel").hidden));
  });

  // Tab switch
  const switchTab = (mode) => {
    const isSched = mode === "sched";
    el("tabSched").setAttribute("aria-selected", String(isSched));
    el("tabNormal").setAttribute("aria-selected", String(!isSched));
    el("paneSched").hidden = !isSched;
    el("paneNormal").hidden = isSched;
  };
  el("tabSched").onclick = trusted(() => switchTab("sched"));
  el("tabNormal").onclick = trusted(() => switchTab("normal"));

  // --- Scheduled 162 tab ---
  const updateDurationLabel = () => {
    const s = Number(el("sStart").value);
    const e = Number(el("sEnd").value);
    const hrs = e - s;
    el("sDuration").textContent =
      hrs > 0
        ? `固定：宋韵云图（四楼）162号 · ${String(s).padStart(2, "0")}:00—${String(e).padStart(2, "0")}:00（${hrs}小时 / ${hrs * 3600}秒 / 1人）`
        : "时段无效：结束时间必须晚于开始时间";
  };
  updateDurationLabel();

  const onTimeChange = () => {
    updateDurationLabel();
    actions.updateHours(Number(el("sStart").value), Number(el("sEnd").value));
  };
  el("sStart").onchange = onTimeChange;
  el("sEnd").onchange = onTimeChange;

  el("sStartBtn").onclick = trusted(() =>
    actions.start(el("sAuth").checked, authDay, Number(el("sStart").value), Number(el("sEnd").value)),
  );
  el("sStopBtn").onclick = trusted(() => actions.stop());
  el("sReviewBtn").onclick = trusted(() => actions.review());

  const copyHelper = async (textarea, statusEl, getter) => {
    try {
      const value = JSON.stringify(await getter(), null, 2);
      textarea.value = value;
      textarea.hidden = false;
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(value);
          statusEl.textContent = "脱敏日志已复制";
          return;
        } catch {
          /* Safari fallback */
        }
      }
      textarea.focus();
      textarea.select();
      statusEl.textContent = "请长按文本框全选复制";
    } catch {
      statusEl.textContent = "日志读取失败";
    }
  };

  el("sToggleLog").onclick = trusted(async () => {
    el("sLogText").value = JSON.stringify(await actions.exportSched(), null, 2);
    el("sLogText").hidden = !el("sLogText").hidden;
  });
  el("sCopyLog").onclick = trusted(() => copyHelper(el("sLogText"), el("sCopyStatus"), actions.exportSched));

  // --- Normal P7.0 tab (reuses IpadBookingEngine directly) ---
  let nRange = null;
  let nRooms = [];
  let nPreview = null;
  let nBusy = false;

  const nClear = () => {
    nPreview = null;
    el("nDetails").checked = el("nRules").checked = false;
    el("nDetails").disabled = el("nRules").disabled = true;
    el("nSubmit").disabled = true;
    el("nPreview").textContent = "尚未准备预约方案";
  };
  const nSyncBtns = () => {
    el("nPrepare").disabled = nBusy || !el("nDate").value || el("nHour").value === "" || !el("nRoom").value || !el("nSeat").value;
    el("nSubmit").disabled = nBusy || !nPreview || !el("nDetails").checked || !el("nRules").checked;
  };
  const nRenderHours = () => {
    el("nHour").replaceChildren();
    if (!nRange || !el("nDate").value) {
      el("nHour").append(new Option("请先选择日期", ""));
      return;
    }
    let cnt = 0;
    for (let h = nRange.min; h < nRange.max; h++) {
      if (Date.parse(`${el("nDate").value}T${String(h).padStart(2, "0")}:00:00+08:00`) <= Date.now()) continue;
      el("nHour").append(new Option(`${String(h).padStart(2, "0")}:00–${String(h + 1).padStart(2, "0")}:00`, String(h)));
      cnt++;
    }
    if (!cnt) el("nHour").append(new Option("当日无可约未来时段", ""));
  };
  const nRenderSeats = () => {
    const floorId = Number(el("nRoom").value);
    const room = nRooms.find((r) => r.floorId === floorId);
    el("nSeat").replaceChildren();
    if (!room) {
      el("nSeat").append(new Option("请先选择房间", ""));
      el("nSeat").disabled = true;
      nSyncBtns();
      return;
    }
    const free = room.seats.filter((s) => s.free);
    if (!free.length) {
      el("nSeat").append(new Option("该房间此时段无空位", ""));
      el("nSeat").disabled = true;
    } else {
      for (const s of free) el("nSeat").append(new Option(`${s.number}号（空闲）`, s.id));
      el("nSeat").disabled = nBusy;
    }
    nSyncBtns();
  };
  normalEngine.notify = ({ code }) => {
    el("nStatus").textContent = P70_MESSAGES[code] || `状态：${code}`;
  };
  const nRun = async (work, keep = false) => {
    if (nBusy) return;
    nBusy = true;
    if (!keep) nClear();
    for (const id of ["nLogin", "nDates", "nQuery", "nPrepare", "nReview", "nDate", "nHour", "nRoom", "nSeat"])
      el(id).disabled = true;
    el("nSubmit").disabled = true;
    try {
      await work();
    } catch (e) {
      nClear();
      el("nStatus").textContent = P70_MESSAGES[codeOf(e)] || `状态：${codeOf(e)}`;
    } finally {
      nBusy = false;
      for (const id of ["nLogin", "nDates", "nQuery", "nReview", "nDate", "nHour"]) el(id).disabled = false;
      el("nRoom").disabled = nRooms.length === 0;
      el("nSeat").disabled = nRooms.length === 0 || !el("nSeat").value;
      nSyncBtns();
    }
  };

  el("nLogin").onclick = trusted(() => nRun(() => normalEngine.checkLogin()));
  el("nDates").onclick = trusted(() =>
    nRun(async () => {
      nRange = await normalEngine.openDates();
      el("nDate").replaceChildren();
      for (const d of nRange.dates.filter((x) => x >= shanghaiDate())) el("nDate").append(new Option(d, d));
      nRenderHours();
    }),
  );
  el("nQuery").onclick = trusted(() =>
    nRun(async () => {
      const data = await normalEngine.queryRooms(el("nDate").value, Number(el("nHour").value));
      nRooms = data.rooms;
      el("nRoom").replaceChildren();
      for (const r of nRooms) el("nRoom").append(new Option(`${r.room}（空闲 ${r.freeCount}/${r.totalCount}）`, String(r.floorId)));
      nRenderSeats();
      el("nRoomMeta").textContent = `共 ${nRooms.length} 个房间，空闲 ${nRooms.reduce((a, r) => a + r.freeCount, 0)} 个；冲突：${data.conflicts}`;
    }),
  );
  el("nPrepare").onclick = trusted(() =>
    nRun(async () => {
      const floorId = Number(el("nRoom").value);
      const room = nRooms.find((r) => r.floorId === floorId);
      const seat = room?.seats.find((s) => s.id === el("nSeat").value);
      nPreview = await normalEngine.prepare({
        date: el("nDate").value,
        hour: Number(el("nHour").value),
        hours: 1,
        floorId,
        room: room?.room || "",
        seatId: seat?.id || "",
        seatNumber: seat?.number || "",
      });
      el("nPreview").textContent = slotSummary(nPreview.target);
      el("nDetails").disabled = el("nRules").disabled = false;
      nSyncBtns();
    }),
  );
  el("nDetails").onchange = el("nRules").onchange = nSyncBtns;
  el("nSubmit").onclick = trusted(() =>
    nRun(async () => {
      const p = nPreview;
      const perms = { details: el("nDetails").checked, rules: el("nRules").checked };
      nClear();
      const res = await normalEngine.confirm(p?.ticket, perms);
      if (res?.target) el("nPreview").textContent = slotSummary(res.target);
    }, true),
  );
  el("nReview").onclick = trusted(() => nRun(() => normalEngine.review()));
  el("nStop").onclick = trusted(() => {
    normalEngine.stop("STOPPED");
    nClear();
  });
  el("nDate").onchange = () => {
    normalEngine.clearSnapshot?.();
    nClear();
    nRenderHours();
    nRooms = [];
    el("nRoom").replaceChildren(new Option("日期已变，请重新查询", ""));
    el("nSeat").replaceChildren(new Option("请先查询", ""));
    el("nRoom").disabled = el("nSeat").disabled = true;
    nSyncBtns();
  };
  el("nHour").onchange = () => {
    normalEngine.clearSnapshot?.();
    nClear();
    nRooms = [];
    el("nRoom").replaceChildren(new Option("时段已变，请重新查询", ""));
    el("nSeat").replaceChildren(new Option("请先查询", ""));
    el("nRoom").disabled = el("nSeat").disabled = true;
    nSyncBtns();
  };
  el("nRoom").onchange = () => {
    nClear();
    nRenderSeats();
  };
  el("nSeat").onchange = () => {
    nClear();
    nSyncBtns();
  };
  el("nToggleLog").onclick = trusted(async () => {
    el("nLogText").value = JSON.stringify(await normalEngine.diagnosticExport(), null, 2);
    el("nLogText").hidden = !el("nLogText").hidden;
  });
  el("nCopyLog").onclick = trusted(() => copyHelper(el("nLogText"), el("nCopyStatus"), () => normalEngine.diagnosticExport()));

  return {
    root,
    host,
    newDay(task) {
      authDay = task.day;
      el("sAuth").checked = false;
      el("sAuth").disabled = false;
      el("sAuthLabel").textContent = `我确认馆方规则且手机未同时承担今日正式预约，授权 ${task.day} 最多一次提交。`;
    },
    renderScheduled(view) {
      schedView = view;
      const locked = view.formal || view.state === "PREPARING";
      el("sStart").disabled = locked;
      el("sEnd").disabled = locked;
      el("sAuth").disabled = locked;
      el("sStartBtn").disabled = locked;
      el("sTarget").textContent = `今日 ${view.task.day} → 预约 ${view.task.date} · 四楼162 (${scheduledTimeLabel(view.task)})`;
      const [label, tone] = P71_PHASES[view.state] || P71_PHASES.UNKNOWN;
      el("toggle").textContent = label;
      el("toggle").dataset.tone = tone;
      el("sStatus").textContent = P71_MESSAGES[view.reason] || `状态：${view.reason}`;
      if (!el("sLogText").hidden) {
        void actions.exportSched().then((d) => {
          el("sLogText").value = JSON.stringify(d, null, 2);
        });
      }
    },
    clock(task, now) {
      const remaining = Math.max(0, Math.ceil((task.open - now) / 1000));
      const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
      const ss = String(remaining % 60).padStart(2, "0");
      const text = `北京时间20:00 · ${remaining ? `剩余 ${mm}:${ss}` : "已到开放时点"}`;
      if (el("sClock").textContent !== text) el("sClock").textContent = text;
      if (remaining > 0 && schedView?.state === "WAITING") {
        const btnLabel = `162 · ${mm}:${ss}`;
        if (el("toggle").textContent !== btnLabel) el("toggle").textContent = btnLabel;
      }
    },
    destroy() {
      destroyed = true;
      observer.disconnect();
      host.remove();
    },
  };
}
