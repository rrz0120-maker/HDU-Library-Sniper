import { codeOf, shanghaiDate, summary } from "./core.js";
export const messages = {
  LOGIN_OK: "官网登录有效（身份信息不展示）",
  AUTH_REQUIRED: "登录已失效，请在官网正常登录后重试只读检查。",
  DATES_OK: "已读取开放日期及允许时段",
  RANGE_SHAPE: "已记录日期字段的脱敏类型",
  DATE_CONTRACT_UNKNOWN: "日期字段格式尚不支持，已禁止提交。请查看并复制脱敏日志以便适配。",
  CLOCK_UNVERIFIED: "手机与服务器时钟无法核对，请检查自动日期时间设置后重新只读检查。",
  ONE_HOUR_NOT_ALLOWED: "馆方当前不允许所选的一小时时段",
  SEATS_CHECKED: "座位与已有预约检查完成",
  SEAT_UNAVAILABLE: "所选座位不可预约，已停止。不会自动尝试其他座位。",
  EXISTING: "已有冲突预约，禁止重复提交",
  AWAITING_CONFIRMATION: "准备完成，真实写入仍关闭，请核对下方方案。",
  SUBMITTING_ONCE: "正在提交一次预约，请保持前台和网络正常。",
  SUCCESS: "预约成功：已通过官方记录核对座位、日期、时间及一小时时长。",
  UNKNOWN: "结果待确认，自动操作已停止。不得重发，请查看预约结果或在官网人工核对。",
  STOPPED: "当前任务已停止；已发送的请求可能完成，停止不会取消已有预约。",
  LIMITED: "馆方限流或限制访问，已停止。请勿继续提交。",
  BUDGET_SPENT: "本浏览器已使用该账号的一次测试额度，请查看预约结果；不会重新提交。",
  PREVIEW_EXPIRED: "准备方案已过期，请重新只读准备",
  CONFIRMATION_REQUIRED: "请先准备，并明确确认完整方案及馆方规则。",
  IDENTITY_CHANGED: "登录账号改变，已停止",
  MAPPING_CHANGED: "座位映射改变，已禁止提交，请重新只读检查。",
  DATE_OR_TIME_NOT_OPEN: "所选日期或时段未开放，或开始时间已过",
  INVALID_TIME: "请选择馆方允许的未来整点时段（1小时）",
  STORAGE_UNAVAILABLE: "本机持久化保护不可用，禁止提交。请使用普通浏览模式并检查存储权限。",
  HTTP_404: "接口返回404，已停止；这不等于座位被抢走。",
  TIMEOUT: "请求超时，已停止；若发生在提交阶段，不得重发。",
  NETWORK_ERROR: "网络请求失败，已停止。",
  RESPONSE_UNKNOWN: "接口响应无法确认，已停止。",
  NO_ATTEMPT: "本浏览器尚无测试提交记录",
  BUSY: "当前操作进行中，请等待或停止。",
  LOCAL_ERROR: "本机处理失败，已停止；如曾提交，请检查官方记录。",
};
export function mount(engine) {
  const host = document.createElement("div");
  host.id = "hdu-p51-panel";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    :host{all:initial;position:fixed;right:8px;bottom:12px;z-index:2147483646;font-family:system-ui,sans-serif;color:#17212c;font-size:16px;line-height:1.5}
    *{box-sizing:border-box}button,input,select{font:inherit}button,select,input[type=checkbox]{touch-action:manipulation}button{min-height:44px;border:1px solid #b4bec8;border-radius:8px;padding:9px 12px;background:#fff;color:#17212c;cursor:pointer}button:disabled{opacity:.5;cursor:default}
    #toggle{background:#164d80;color:white;border:0;box-shadow:0 3px 12px #0004}section{background:#f8fafc;border:1px solid #aab6c2;border-radius:12px;padding:14px;width:min(380px,calc(100vw - 16px));max-height:calc(100vh - 80px);max-height:calc(100dvh - 80px);overflow-y:auto;overscroll-behavior:contain;box-shadow:0 4px 20px #0003;margin-bottom:8px}section[hidden]{display:none}
    h2{font-size:19px;margin:0 0 8px}p{margin:8px 0;overflow-wrap:anywhere}.hint{font-size:13px;color:#475569}.actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0}.fields{display:grid;gap:8px}select{width:100%;min-height:44px;border:1px solid #94a3b8;border-radius:6px;background:white;color:#17212c;padding:8px}label{display:block}.confirm{padding:10px;border:1px solid #cbd5e1;border-radius:8px;margin-top:10px}.confirm label{display:flex;gap:8px;align-items:flex-start;margin:10px 0}input[type=checkbox]{width:22px;height:22px;flex:none}#submit{width:100%;background:#164d80;color:white}#stop{border-color:#a52727;color:#a52727}#status{padding:8px;background:#e7eff7;border-radius:6px}#preview{font-weight:600}textarea{width:100%;height:180px;font:12px/1.5 monospace;white-space:pre-wrap;overflow-wrap:anywhere}#seats{font-size:14px;white-space:pre-wrap}a{color:#164d80}button:focus-visible,select:focus-visible{outline:3px solid #f0b84d}
  </style><section hidden aria-label="P5.1 单次预约测试">
    <h2>P5.1 单次预约测试</h2>
    <p class="hint">宋韵云图（四楼）· 仅 162 / 157 · 1小时 / 1人。真实提交默认关闭。</p>
    <p class="hint">保持浏览器前台、屏幕唤醒及网络正常。暂不提供20:00定时抢座。</p>
    <p id="status" role="status" aria-live="polite">先检查登录，再查询开放日期。</p>
    <div class="actions"><button id="login">检查登录状态</button><button id="dates">查询开放日期</button></div>
    <div class="fields"><label>使用日期（北京时间）<select id="date" aria-label="使用日期"><option value="">先查询开放日期</option></select></label><label>开始时间（时长固定1小时）<select id="hour" aria-label="开始时间"><option value="">先选择日期</option></select></label><label>测试座位<select id="seat" aria-label="测试座位"><option value="162">162</option><option value="157">157</option></select></label></div>
    <div class="actions"><button id="query">查询四楼162/157</button><button id="prepare">准备预约</button></div>
    <p id="seats"></p><div class="confirm"><p id="preview">尚未准备预约方案</p><label><input id="details" type="checkbox" disabled>我确认上述日期、时间、楼层及座位，实际需要使用1小时。</label><label><input id="rules" type="checkbox" disabled>我已核实馆方允许此预约方式，授权本次最多一次提交。</label><button id="submit" disabled>确认提交一次预约</button></div>
    <div class="actions"><button id="result">查看预约结果</button><button id="logs">查看运行日志</button><button id="stop">停止当前任务</button><button id="copy">复制脱敏日志</button></div>
    <textarea id="logtext" aria-label="脱敏运行日志" readonly hidden></textarea>
    <p class="hint">防重复记录只在当前浏览器内有效。请勿用无痕模式、清除网站数据、重装或换设备绕过次数保护。停止任务不会取消预约。</p>
  </section><button id="toggle" aria-expanded="false">P5.1 预约测试</button>`;
  document.documentElement.append(host);
  const el = (id) => root.getElementById(id);
  let range = null,
    preview = null,
    uiBusy = false;
  const status = (code) => {
    el("status").textContent = messages[code] || `已停止：${code}（请查看脱敏日志）`;
  };
  const clear = () => {
    preview = null;
    el("details").checked = el("rules").checked = false;
    el("details").disabled = el("rules").disabled = true;
    el("submit").disabled = true;
    el("preview").textContent = "尚未准备预约方案";
  };
  const showLogs = () => {
    el("logtext").value = JSON.stringify(
      {
        version: "P5.1.0",
        realPerformance: "只代表本次手机环境，不代表20:00高峰；网络、排队和服务器时间无法分离",
        logs: engine.logs,
      },
      null,
      2,
    );
  };
  engine.notify = ({ code, details }) => {
    status(code === "STOPPED" && details.reason ? details.reason : code);
    showLogs();
  };
  function selection() {
    return {
      date: el("date").value,
      hour: el("hour").value === "" ? -1 : Number(el("hour").value),
      hours: 1,
      seat: el("seat").value,
    };
  }
  function hours() {
    const old = el("hour").value;
    el("hour").replaceChildren();
    if (!range || !el("date").value) return;
    for (let h = range.min; h < range.max; h++) {
      if (Date.parse(`${el("date").value}T${String(h).padStart(2, "0")}:00:00+08:00`) <= Date.now()) continue;
      const opt = document.createElement("option");
      opt.value = String(h);
      opt.textContent = `${String(h).padStart(2, "0")}:00–${String(h + 1).padStart(2, "0")}:00`;
      el("hour").append(opt);
    }
    if ([...el("hour").options].some((o) => o.value === old)) el("hour").value = old;
  }
  async function action(work, keep = false) {
    if (uiBusy) return;
    uiBusy = true;
    if (!keep) clear();
    for (const id of ["login", "dates", "query", "prepare", "result", "date", "hour", "seat"])
      el(id).disabled = true;
    el("submit").disabled = true;
    try {
      await work();
    } catch (e) {
      clear();
      status(codeOf(e));
    } finally {
      uiBusy = false;
      for (const id of ["login", "dates", "query", "prepare", "result", "date", "hour", "seat"])
        el(id).disabled = false;
      el("submit").disabled = !preview || !el("details").checked || !el("rules").checked;
    }
  }
  el("toggle").onclick = () => {
    const section = root.querySelector("section");
    section.hidden = !section.hidden;
    el("toggle").setAttribute("aria-expanded", String(!section.hidden));
  };
  el("login").onclick = () => action(() => engine.checkLogin());
  el("dates").onclick = () =>
    action(async () => {
      range = await engine.openDates();
      el("date").replaceChildren();
      for (const date of range.dates.filter((d) => d >= shanghaiDate())) {
        const opt = document.createElement("option");
        opt.value = date;
        opt.textContent = date;
        el("date").append(opt);
      }
      hours();
    });
  const showSeats = (mapping, count) => {
    el("seats").textContent =
      `${mapping.room}\n${mapping.seats.map((s) => `${s.number}：内部ID ${s.id}，${s.free ? "该时段空闲" : "不可预约"}`).join("\n")}\n已有冲突预约：${count}`;
  };
  el("query").onclick = () =>
    action(async () => {
      const data = await engine.querySeats(selection());
      showSeats(data.mapping, data.conflicts);
    });
  el("prepare").onclick = () =>
    action(async () => {
      preview = await engine.prepare(selection());
      showSeats(preview.mapping, 0);
      el("preview").textContent = summary(preview.selection);
      el("details").disabled = el("rules").disabled = false;
    });
  const toggleConfirm = () => {
    el("submit").disabled = uiBusy || !preview || !el("details").checked || !el("rules").checked;
  };
  el("details").onchange = el("rules").onchange = toggleConfirm;
  el("submit").onclick = (event) => {
    if (!event.isTrusted) {
      status("CONFIRMATION_REQUIRED");
      return;
    }
    return action(async () => {
      const p = preview;
      const permissions = { details: el("details").checked, rules: el("rules").checked };
      clear();
      const result = await engine.confirm(p?.ticket, permissions);
      status(result.state === "STOPPED" ? result.reason : result.state);
      el("preview").textContent = result.selection ? summary(result.selection) : "无提交记录";
    }, true);
  };
  el("result").onclick = () =>
    action(async () => {
      const result = await engine.review();
      if (result.selection) el("preview").textContent = summary(result.selection);
    });
  el("stop").onclick = () => {
    engine.stop();
    clear();
  };
  for (const id of ["date", "hour", "seat"])
    el(id).onchange = () => {
      engine.stop();
      clear();
      el("seats").textContent = "参数已改变，需要重新只读检查";
      if (id === "date") hours();
    };
  el("logs").onclick = () => {
    showLogs();
    el("logtext").hidden = !el("logtext").hidden;
  };
  el("copy").onclick = async () => {
    showLogs();
    el("logtext").hidden = false;
    try {
      await navigator.clipboard.writeText(el("logtext").value);
    } catch {
      el("logtext").focus();
      el("logtext").select();
    }
  };
}
