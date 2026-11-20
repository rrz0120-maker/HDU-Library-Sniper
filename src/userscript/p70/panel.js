import { ORIGIN, codeOf, shanghaiDate } from "../core.js";
import { slotSummary } from "./policy.js";

export const P70_MESSAGES = {
  READ_ONLY_DEFAULT: "默认只读；请先检查登录并读取开放日期。",
  LOGIN_OK: "官网登录有效（账号信息不展示）。",
  AUTH_REQUIRED: "登录已失效，请在官网正常登录后重新检查。",
  RANGE_SHAPE: "已记录馆方日期字段脱敏结构。",
  DATES_OK: "已读取开放日期与允许时段，请选择日期与1小时时段后查询空位。",
  DATE_CONTRACT_UNKNOWN: "日期字段格式尚不支持，已禁止提交。",
  CLOCK_UNVERIFIED: "设备与服务器时钟偏差过大或无法核对，请检查iPad自动日期与时间设置。",
  ONE_HOUR_NOT_ALLOWED: "馆方当前不允许该1小时预约规则。",
  SEATS_CHECKED: "已读取房间与当前空余座位，请选择空闲座位并点击准备预约方案。",
  SEAT_REQUIRED: "请先选择一个当前空余座位。",
  SEAT_UNAVAILABLE: "所选座位已不可预约，已停止。不会自动换座。",
  EXISTING: "该时段已有冲突预约，禁止重复提交。",
  PREVIOUS_UNKNOWN: "存在未决提交记录，已禁止新预约。请先点“查看官方结果”核验或人工检查官网。",
  CROSS_MODE_ACTIVE_TASK: "整点预约模式正在待命或执行，普通模式已互斥阻断。",
  CROSS_MODE_UNKNOWN: "整点预约模式存在未决(UNKNOWN)记录，请先在整点模式核验官方记录。",
  CROSS_MODE_CONFLICT: "整点模式已占用同日期任务，普通模式已互斥阻断。",
  AWAITING_CONFIRMATION: "方案已就绪（5分钟内有效），真实提交仍关闭；请核对后双勾选确认。",
  SUBMITTING_ONCE: "正在提交唯一一次预约请求，请保持Safari在前台且屏幕唤醒。",
  RECORD_VERIFIED: "预约成功：已通过官方记录核验房间、座位、日期与1小时时长。",
  REVIEW_SAVED_RESULT: "已核验成功的预约记录，不重复提交。",
  RECORD_NOT_VERIFIED: "官方记录暂未匹配到本次预约，请查看官网“我的预约”；不会自动重发。",
  READ_CHECK_LIMIT_OR_ERROR: "核验次数已达上限或间隔不足2秒，请直接查看官网“我的预约”。",
  UNKNOWN: "结果待确认，已停止且不会自动重发，请先点“查看官方结果”或核对官网。",
  STOPPED: "当前任务已停止；若已发出提交请求，停止不会撤销预约。",
  FOREGROUND_REQUIRED: "页面离开前台，操作已中止；不会自动恢复提交。",
  LIMITED: "馆方限流或拒绝访问，已停止。",
  BUDGET_SPENT: "该时段座位已使用过单次提交额度，请查看官方结果；不会重复提交。",
  PREVIEW_EXPIRED: "预约方案已超过5分钟有效期，请重新准备。",
  CONFIRMATION_REQUIRED: "请先准备方案，并手动勾选两项确认后再提交。",
  IDENTITY_CHANGED: "登录账号已变化，已停止。",
  MAPPING_CHANGED: "房间或座位映射发生变化，已禁止提交，请重新查询。",
  DATE_OR_TIME_NOT_OPEN: "所选日期或时段未开放，或开始时间已过。",
  INVALID_TIME: "请选择馆方允许的未来整点1小时时段。",
  STORAGE_UNAVAILABLE: "Safari本地存储（IndexedDB/localStorage）不可用，禁止提交。请关闭无痕浏览并检查权限。",
  HTTP_404: "接口返回404，已停止；若发生在提交阶段，请先核验官方记录。",
  TIMEOUT: "请求超时，已停止；若发生在提交阶段，不得自动重发，请核验官方记录。",
  NETWORK_ERROR: "网络异常，已停止；若发生在提交阶段，请核验官方记录。",
  RESPONSE_UNKNOWN: "接口响应无法解析，已停止。",
  NO_ATTEMPT: "本机尚无P7.0提交记录。",
  BUSY: "当前操作进行中，请等待或点击停止。",
  LOCAL_ERROR: "本机处理异常，已停止；如已提交请先核对官方记录。",
};

const P70_TONES = {
  IDLE: ["iPad P7.0 · 待机", "idle"],
  READY_READ_ONLY: ["iPad P7.0 · 只读", "active"],
  AWAITING_CONFIRMATION: ["iPad P7.0 · 待确认", "active"],
  SUBMITTING: ["iPad P7.0 · 提交中", "active"],
  SUCCESS: ["iPad P7.0 · 已成功", "success"],
  FAILED: ["iPad P7.0 · 未成功", "failed"],
  UNKNOWN: ["iPad P7.0 · 待核验", "unknown"],
  STOPPED: ["iPad P7.0 · 已停止", "stopped"],
};

export function mountIpadPanel(engine) {
  const host = document.createElement("div");
  host.id = "hdu-p70-host";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    :host{all:initial;position:fixed;right:max(12px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#142636;font-size:15px;line-height:1.45}
    *{box-sizing:border-box}[hidden]{display:none!important}
    button,input,select,textarea{font-family:inherit;font-size:16px}
    button,select,input[type=checkbox]{touch-action:manipulation}
    button{min-height:44px;padding:8px 12px;border:1px solid #9db0be;border-radius:10px;background:#fff;color:#142636;cursor:pointer}
    button:disabled{opacity:.5;cursor:default}
    #toggle{float:right;background:#154c79;color:#fff;border:0;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,.22)}
    #toggle[data-tone=success]{background:#17633b}#toggle[data-tone=failed]{background:#a0212b}#toggle[data-tone=unknown]{background:#945008}#toggle[data-tone=stopped]{background:#59646b}
    #panel{clear:both;width:min(400px,calc(100vw - 24px));max-height:min(76vh,calc(100dvh - 88px));overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;background:#f8fafc;border:1px solid #9db0be;border-radius:14px;padding:14px;margin-bottom:8px;box-shadow:0 8px 28px rgba(0,0,0,.2);overflow-wrap:anywhere}
    h2{font-size:18px;margin:0 0 6px}p{margin:6px 0}.hint{font-size:13px;color:#466070}
    #status{padding:9px 10px;border-radius:8px;background:#e6f0f8;font-weight:500}
    .grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0}
    .fields{display:grid;gap:8px;margin:8px 0}
    label{display:block;font-size:14px}
    select{width:100%;min-height:44px;margin-top:4px;padding:8px 10px;border:1px solid #94a3b8;border-radius:8px;background:#fff;color:#142636}
    .confirm{margin:10px 0;padding:10px;border:1px solid #cbd5e1;border-radius:10px;background:#fff}
    .confirm label{display:flex;gap:8px;align-items:flex-start;margin:8px 0}
    input[type=checkbox]{width:22px;height:22px;flex:none;margin-top:2px}
    #preview{font-weight:600;color:#142636}
    #submit{width:100%;background:#154c79;color:#fff;border:0;font-weight:600}
    #stop{border-color:#a52727;color:#a52727}
    #roomMeta{font-size:13px;color:#334e60;white-space:pre-wrap}
    textarea{width:100%;height:170px;margin-top:8px;padding:8px;border:1px solid #94a3b8;border-radius:8px;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;background:#fff;color:#142636}
    a{color:#154c79;font-weight:500}
  </style>
  <section id="panel" hidden aria-label="P7.0 iPad 原生预约验证">
    <h2>P7.0 iPad 原生预约 · Phase 1</h2>
    <p class="hint">Safari + Userscripts 单次空余座位预约验证（1小时 / 1人）。不含20:00抢座、不自动重试、不伪造旧凭据。</p>
    <p id="status" role="status" aria-live="polite">${P70_MESSAGES.READ_ONLY_DEFAULT}</p>
    <div class="grid2"><button id="login">1. 检查登录</button><button id="dates">2. 读取开放日期</button></div>
    <div class="fields">
      <label>预约日期（北京时间）<select id="date"><option value="">请先读取开放日期</option></select></label>
      <label>1小时时段<select id="hour"><option value="">请先选择日期</option></select></label>
    </div>
    <div class="grid2"><button id="query">3. 查询房间与空位</button><button id="prepare" disabled>4. 准备预约方案</button></div>
    <div class="fields">
      <label>选择房间<select id="room" disabled><option value="">请先查询房间与空位</option></select></label>
      <label>当前空余座位<select id="seat" disabled><option value="">请先选择房间</option></select></label>
    </div>
    <p id="roomMeta"></p>
    <div class="confirm">
      <p id="preview">尚未准备预约方案</p>
      <label><input id="details" type="checkbox" disabled><span>我确认上述房间、空余座位、日期及1小时时段，本人实际使用。</span></label>
      <label><input id="rules" type="checkbox" disabled><span>我已确认馆方允许本次正常预约，并授权最多一次正式提交。</span></label>
      <button id="submit" disabled>5. 确认提交一次预约</button>
    </div>
    <div class="grid2">
      <button id="review">查看官方结果</button>
      <button id="stop">停止任务</button>
      <button id="toggleLogs">显示/隐藏日志</button>
      <button id="copy">复制脱敏日志</button>
    </div>
    <p class="hint"><a href="${ORIGIN}/#!/Seat/Index/myBookingList" target="_blank" rel="noopener noreferrer">打开官方“我的预约”</a> · <span id="copyStatus"></span></p>
    <textarea id="logText" readonly hidden aria-label="脱敏JSON日志"></textarea>
  </section>
  <button id="toggle" aria-expanded="false" data-tone="idle">iPad P7.0 · 待机</button>`;

  const el = (id) => root.getElementById(id);
  let range = null;
  let rooms = [];
  let preview = null;
  let uiBusy = false;
  let destroyed = false;

  const attach = () => {
    if (!destroyed && location.origin === ORIGIN && !host.isConnected)
      (document.documentElement || document.body)?.append(host);
  };
  attach();

  const observer = new MutationObserver(() => {
    if (!destroyed && location.origin === ORIGIN && !host.isConnected) attach();
  });
  observer.observe(document, { childList: true, subtree: true });

  const setTone = (state, code) => {
    const [label, tone] = P70_TONES[state] || P70_TONES.UNKNOWN;
    el("toggle").textContent = label;
    el("toggle").dataset.tone = tone;
    el("status").textContent = P70_MESSAGES[code] || `状态：${code}（请查看脱敏日志）`;
  };

  const clearPreview = () => {
    preview = null;
    el("details").checked = false;
    el("rules").checked = false;
    el("details").disabled = true;
    el("rules").disabled = true;
    el("submit").disabled = true;
    el("preview").textContent = "尚未准备预约方案";
  };

  const syncPrepareBtn = () => {
    el("prepare").disabled = uiBusy || !el("date").value || el("hour").value === "" || !el("room").value || !el("seat").value;
  };

  const syncConfirmBtn = () => {
    el("submit").disabled = uiBusy || !preview || !el("details").checked || !el("rules").checked;
  };

  const renderHours = () => {
    const old = el("hour").value;
    el("hour").replaceChildren();
    if (!range || !el("date").value) {
      el("hour").append(new Option("请先选择日期", ""));
      return;
    }
    let count = 0;
    for (let h = range.min; h < range.max; h++) {
      const startMs = Date.parse(`${el("date").value}T${String(h).padStart(2, "0")}:00:00+08:00`);
      if (startMs <= Date.now()) continue;
      el("hour").append(new Option(`${String(h).padStart(2, "0")}:00–${String(h + 1).padStart(2, "0")}:00`, String(h)));
      count++;
    }
    if (!count) el("hour").append(new Option("当日已无可约未来时段", ""));
    else if ([...el("hour").options].some((o) => o.value === old)) el("hour").value = old;
  };

  const renderSeatsForRoom = () => {
    const floorId = Number(el("room").value);
    const room = rooms.find((r) => r.floorId === floorId);
    el("seat").replaceChildren();
    if (!room) {
      el("seat").append(new Option("请先选择房间", ""));
      el("seat").disabled = true;
      syncPrepareBtn();
      return;
    }
    const freeSeats = room.seats.filter((s) => s.free);
    if (!freeSeats.length) {
      el("seat").append(new Option("该房间此时段无空余座位", ""));
      el("seat").disabled = true;
    } else {
      for (const s of freeSeats) el("seat").append(new Option(`${s.number}号（空闲）`, s.id));
      el("seat").disabled = uiBusy;
    }
    syncPrepareBtn();
  };

  const refreshLogs = async () => {
    try {
      el("logText").value = JSON.stringify(await engine.diagnosticExport(), null, 2);
    } catch {
      el("logText").value = JSON.stringify({ version: "7.0.2-phase1", error: "EXPORT_FAILED" });
    }
  };

  engine.notify = ({ state, code }) => {
    setTone(state, code);
    if (!el("logText").hidden) void refreshLogs();
  };

  const currentSelection = () => {
    const floorId = Number(el("room").value);
    const room = rooms.find((r) => r.floorId === floorId);
    const seat = room?.seats.find((s) => s.id === el("seat").value);
    return {
      date: el("date").value,
      hour: el("hour").value === "" ? -1 : Number(el("hour").value),
      hours: 1,
      floorId,
      room: room?.room || "",
      seatId: seat?.id || "",
      seatNumber: seat?.number || "",
    };
  };

  const runAction = async (work, keepPreview = false) => {
    if (uiBusy) return;
    uiBusy = true;
    if (!keepPreview) clearPreview();
    const controls = ["login", "dates", "query", "prepare", "review", "date", "hour", "room", "seat"];
    for (const id of controls) el(id).disabled = true;
    el("submit").disabled = true;
    try {
      await work();
    } catch (e) {
      clearPreview();
      setTone(engine.state === "SUBMITTING" ? "UNKNOWN" : "STOPPED", codeOf(e));
    } finally {
      uiBusy = false;
      for (const id of ["login", "dates", "query", "review", "date", "hour"]) el(id).disabled = false;
      el("room").disabled = rooms.length === 0;
      el("seat").disabled = rooms.length === 0 || el("seat").options.length === 0 || !el("seat").value;
      syncPrepareBtn();
      syncConfirmBtn();
    }
  };

  const trusted = (fn) => (event) => {
    if (event.isTrusted) void fn();
  };

  el("toggle").onclick = trusted(() => {
    el("panel").hidden = !el("panel").hidden;
    el("toggle").setAttribute("aria-expanded", String(!el("panel").hidden));
  });

  el("login").onclick = trusted(() => runAction(() => engine.checkLogin()));

  el("dates").onclick = trusted(() =>
    runAction(async () => {
      range = await engine.openDates();
      el("date").replaceChildren();
      const openDates = range.dates.filter((d) => d >= shanghaiDate());
      if (!openDates.length) el("date").append(new Option("暂无开放日期", ""));
      else for (const d of openDates) el("date").append(new Option(d, d));
      renderHours();
    }),
  );

  el("query").onclick = trusted(() =>
    runAction(async () => {
      const data = await engine.queryRooms(el("date").value, Number(el("hour").value));
      rooms = data.rooms;
      el("room").replaceChildren();
      for (const r of rooms)
        el("room").append(new Option(`${r.room}（空闲 ${r.freeCount}/${r.totalCount}）`, String(r.floorId)));
      renderSeatsForRoom();
      const totalFree = rooms.reduce((s, r) => s + r.freeCount, 0);
      el("roomMeta").textContent = `共读取 ${rooms.length} 个房间，当前空闲座位 ${totalFree} 个；此时段已有冲突预约：${data.conflicts}`;
    }),
  );

  el("prepare").onclick = trusted(() =>
    runAction(async () => {
      preview = await engine.prepare(currentSelection());
      el("preview").textContent = slotSummary(preview.target);
      el("details").disabled = false;
      el("rules").disabled = false;
      syncConfirmBtn();
    }),
  );

  el("details").onchange = el("rules").onchange = syncConfirmBtn;

  el("submit").onclick = (event) => {
    if (!event.isTrusted) {
      setTone("STOPPED", "CONFIRMATION_REQUIRED");
      return;
    }
    void runAction(async () => {
      const p = preview;
      const perms = { details: el("details").checked, rules: el("rules").checked };
      clearPreview();
      const result = await engine.confirm(p?.ticket, perms);
      if (result?.target) el("preview").textContent = slotSummary(result.target);
      await refreshLogs();
    }, true);
  };

  el("review").onclick = trusted(() =>
    runAction(async () => {
      const result = await engine.review();
      if (result?.target) el("preview").textContent = slotSummary(result.target);
      await refreshLogs();
    }),
  );

  el("stop").onclick = trusted(() => {
    engine.stop("STOPPED");
    clearPreview();
  });

  el("date").onchange = () => {
    engine.clearSnapshot?.();
    clearPreview();
    renderHours();
    rooms = [];
    el("room").replaceChildren(new Option("日期已变，请重新查询房间与空位", ""));
    el("seat").replaceChildren(new Option("请先查询房间与空位", ""));
    el("room").disabled = true;
    el("seat").disabled = true;
    el("roomMeta").textContent = "";
    syncPrepareBtn();
  };

  el("hour").onchange = () => {
    engine.clearSnapshot?.();
    clearPreview();
    rooms = [];
    el("room").replaceChildren(new Option("时段已变，请重新查询房间与空位", ""));
    el("seat").replaceChildren(new Option("请先查询房间与空位", ""));
    el("room").disabled = true;
    el("seat").disabled = true;
    el("roomMeta").textContent = "";
    syncPrepareBtn();
  };

  el("room").onchange = () => {
    clearPreview();
    renderSeatsForRoom();
  };

  el("seat").onchange = () => {
    clearPreview();
    syncPrepareBtn();
  };

  el("toggleLogs").onclick = trusted(async () => {
    await refreshLogs();
    el("logText").hidden = !el("logText").hidden;
  });

  el("copy").onclick = trusted(async () => {
    await refreshLogs();
    el("logText").hidden = false;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(el("logText").value);
        el("copyStatus").textContent = "脱敏日志已复制";
        return;
      } catch {
        /* Safari gesture fallback */
      }
    }
    el("logText").focus();
    el("logText").select();
    el("copyStatus").textContent = "请长按下方文本框全选复制";
  });

  return {
    root,
    host,
    destroy() {
      destroyed = true;
      observer.disconnect();
      host.remove();
    },
  };
}
