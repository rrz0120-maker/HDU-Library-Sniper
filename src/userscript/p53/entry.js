import { ORIGIN, codeOf } from "../core.js";
import { Transport } from "../transport.js";
import { SingleEngine } from "./engine.js";
import { FormalStore } from "./store.js";
import { TASK } from "./policy.js";

if (location.origin === ORIGIN && window.top === window.self && !document.getElementById("hdu-p53-host")) {
  const host = document.createElement("div");
  host.id = "hdu-p53-host";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    :host{all:initial;position:fixed;right:10px;bottom:68px;z-index:2147483646;font:15px/1.5 system-ui,sans-serif;color:#17232b}
    *{box-sizing:border-box}button,input{font:inherit}button{min-height:44px;border:1px solid #9aabb4;border-radius:9px;padding:9px;background:#f7fafc;color:#17232b;touch-action:manipulation}button:disabled{opacity:.55}
    #toggle{background:#174e68;color:white;float:right}#panel{clear:both;background:white;border:1px solid #9aabb4;border-radius:12px;padding:12px;width:min(360px,calc(100vw - 20px));max-height:74vh;overflow:auto;box-shadow:0 3px 18px #0003}
    [hidden]{display:none!important}h2{font-size:18px;margin:0 0 8px}p{margin:8px 0}small{display:block;color:#465c69}label{display:flex;gap:8px;padding:8px 0}input{width:22px;height:22px;flex-shrink:0}#actions{display:grid;grid-template-columns:1fr;gap:8px}#prepare{background:#174e68;color:#fff}#state{font-weight:700;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 monospace}summary{min-height:44px;padding:10px 0}a{color:#174e68}
  </style>
  <button id="toggle" aria-expanded="false">P5.3 · 162</button>
  <section id="panel" hidden aria-label="P5.3 单座预约">
    <h2>P5.3 · 仅 162，一次提交</h2>
    <p>宋韵云图（四楼）<br>2026-11-19 · 08:00–22:00<br>14 小时 / 50400 秒 / 1 人</p>
    <p id="clock"></p><small>开放时点：11 月 17 日 20:00（北京时间）。秒级校时会保守延后，不保证准点。</small>
    <p id="checks">登录：未检查 · 座位 ID：未验证</p>
    <p id="state" role="status">未启动 · 默认只读演练</p>
    <p id="explain"></p>
    <label><input id="arm" type="checkbox">我确认馆方允许此方式及上述日期、时段和座位，启用 11 月 17 日正式任务（仅一次）</label>
    <small>未勾选＝只读演练。正式准备限 19:58–20:00 前；准备后勿更换账号、手动预约或在其他设备操作同一账号。</small>
    <div id="actions"><button id="prepare">准备抢座</button><button id="stop">停止自动任务</button><button id="review">查看结果</button></div>
    <p>保持浏览器前台、屏幕唤醒和网络正常。切到后台即停止；刷新不会恢复提交。请先关闭 P5.2 的悬浮面板，保留其脚本和数据。</p>
    <details><summary>运行日志（脱敏）</summary><pre id="logs"></pre></details>
    <a href="https://hdu.huitu.zhishulib.com/#!/Seat/Index/myBookingList" target="_blank" rel="noopener noreferrer">官方我的预约</a>
  </section>`;
  document.documentElement.append(host);
  const el = (id) => root.getElementById(id);
  const states = {
    IDLE: "未启动",
    PREPARING: "只读检查中",
    READY_READ_ONLY: "只读演练通过 · 未启用提交",
    WAITING: "已授权待命 · 等待 20:00",
    SUCCESS: "SUCCESS — 162号预约成功",
    FAILED: "FAILED — 自动任务已结束",
    UNKNOWN: "UNKNOWN — 预约结果待确认",
    STOPPED: "已停止 · 不会发起新的写入",
  };
  const reasons = {
    SUBMITTING_ONCE: "首次请求已开始，等待响应。没有自动重试。",
    SERVER_SUCCESS: "服务器表示成功，正在核验官方记录。",
    RECORD_VERIFIED: "官方记录已核对日期、08:00–22:00、14 小时、四楼 162 及有效状态。",
    SEAT_UNAVAILABLE: "馆方明确拒绝：座位不可预约。没有备用座位任务。",
    NOT_OPEN: "馆方明确拒绝：时间范围未开放。不会重发。",
    EXISTING: "目标时段已有预约或馆方拒绝重复预约。",
    LIMITED: "馆方限流或拒绝访问，已停止后续自动请求。",
    AUTH_REQUIRED: "登录已失效，请在官网重新认证；本任务不会自动恢复。",
    P52_RECEIPT_REQUIRED:
      "需要本浏览器、同账号的 P5.2 成功核验记录。请用 P5.2 查看结果；不要清除数据或换账号。",
    HISTORY_MAPPING_MISMATCH: "P5.2 历史映射不匹配，请保留日志。禁止提交。",
    TASK_ALREADY_RESERVED: "已存在正式任务。刷新或再次点击不会创建第二次提交；可查看结果或停止任务。",
    PREPARE_WINDOW: "正式准备仅限 2026-11-17 北京时间 19:58–20:00 前。现在可取消勾选做只读演练。",
    MISSED_WINDOW: "已超出保守的整点执行窗口（最多 10 秒），停止写入，请手动接管。",
    USER_STOPPED: "已停止。若请求已发出，停止不能撤销服务器处理，请查官方记录。",
    FOREGROUND_REQUIRED: "网页离开前台，任务已停止，不会自动恢复。",
    REHEARSAL_PASSED: "登录、合法日期、历史映射、14 小时时段、冲突检查和本地持久化通过；没有预约写入。",
    ARMED_FOR_2000: "只提交四楼 162 一次。请保持前台，勿切换账号。",
    HTTP_404: "接口返回 404，不能判断是否落单。不会重发。",
    TIMEOUT: "请求超时，服务器可能已受理。不会重发。",
    NETWORK_ERROR: "网络错误，结果不明确。不会重发。",
    READ_CHECK_LIMIT_OR_ERROR: "只读核验受限或失败；最多自动一次、手动两次。请转官方我的预约查看。",
    RECORD_NOT_VERIFIED: "官方记录尚不能证明完整目标成功。不会重发。",
    CLOCK_UNVERIFIED: "馆方时间不可验证或偏差过大，禁止提交。请保持手机自动校时。",
    CLOCK_CHANGED_OR_STALE: "校时样本过期、手机时间变化或页面暂停，已停止。",
  };
  const store = new FormalStore();
  const render = (view) => {
    el("state").textContent = states[view.state] || view.state;
    el("explain").textContent = reasons[view.reason] || `状态代码：${view.reason}。没有自动重试。`;
    el("checks").textContent =
      `登录：${view.login ? "有效（准备时）" : "未检查"} · 座位 ID：${view.mapping ? "162 → 62726 / 房间 1558 已验证" : "未验证"}`;
    el("logs").textContent = JSON.stringify({ timings: view.timings, events: view.logs }, null, 2);
    el("prepare").disabled = view.formal || view.state === "PREPARING";
    el("arm").disabled = view.formal || view.state === "PREPARING";
  };
  const engine = new SingleEngine(new Transport(), store, render);
  const action = (fn) => async (event) => {
    if (!event.isTrusted) return;
    try {
      await fn();
    } catch (error) {
      engine.emit("STOPPED", codeOf(error));
    }
  };
  el("toggle").onclick = () => {
    el("panel").hidden = !el("panel").hidden;
    el("toggle").setAttribute("aria-expanded", String(!el("panel").hidden));
  };
  el("prepare").onclick = action(() =>
    engine.prepare({ arm: el("arm").checked, confirmed: el("arm").checked }),
  );
  el("stop").onclick = action(() => engine.stop());
  el("review").onclick = action(() => engine.review());
  const suspend = () => {
    if (engine.formal) void engine.stop("FOREGROUND_REQUIRED");
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") suspend();
  });
  document.addEventListener("freeze", suspend);
  window.addEventListener("pagehide", suspend);
  window.addEventListener("storage", () => {
    if (engine.formal && store.stopped()) void engine.stop();
  });
  const fmt = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const loop = () => {
    const remaining = Math.ceil((TASK.open - Date.now()) / 1000);
    el("clock").textContent =
      `北京时间 ${fmt.format(Date.now())} · ${remaining > 0 ? `距开放 ${remaining} 秒` : "已到开放时点（仍须通过安全门禁）"}`;
    void engine.tick();
    setTimeout(loop, engine.waiting && remaining <= 2 ? 50 : 250);
  };
  loop();
}
