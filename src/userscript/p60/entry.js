import { ORIGIN, codeOf } from "../core.js";
import { Transport } from "../transport.js";
import { DailyEngine } from "./engine.js";
import { DailyStore } from "./store.js";
import { dailyTask } from "./policy.js";
import { mountPanel } from "./panel.js";

if (location.origin === ORIGIN && window.top === window.self && !document.getElementById("hdu-p60-host")) {
  let current, viewing, panel;
  const display = (view, source) => {
    if (source === viewing) panel.render(view, source);
  };
  const create = (task, canWrite = true) => {
    const engine = new DailyEngine(new Transport(), new DailyStore(task), (v) => display(v, engine), {
      task,
      canWrite,
    });
    return engine;
  };
  function dayCheck() {
    const task = dailyTask();
    if (current?.task.day === task.day) return false;
    if (current?.formal) void current.suspend("AUTHORIZATION_EXPIRED");
    current = create(task);
    viewing = current;
    panel.newDay(task);
    panel.render(current.view(), current);
    return true;
  }
  const action = async (fn) => {
    try {
      await fn();
    } catch (e) {
      viewing.emit(viewing.attempted ? "UNKNOWN" : "STOPPED", codeOf(e));
    }
  };
  panel = mountPanel({
    start: (arm, authorizedDay) =>
      action(async () => {
        if (dayCheck()) return; // A click on yesterday's checkbox cannot authorize today.
        viewing = current;
        panel.render(current.view(), current);
        await current.prepare({ arm, confirmed: arm, authorizedDay });
      }),
    stop: () =>
      action(async () => {
        await current.suspend("USER_STOPPED");
        if (viewing !== current) await viewing.suspend("USER_STOPPED");
      }),
    review: (day) =>
      action(async () => {
        if (current.busy || current.waiting) return;
        dayCheck();
        viewing =
          day && day !== current.task.day
            ? create(dailyTask(Date.parse(`${day}T12:00:00+08:00`)), false)
            : current;
        panel.render(viewing.view(), viewing);
        await viewing.review();
      }),
    recent: () =>
      action(async () => {
        const engine = viewing.identity ? viewing : current;
        if (!engine.identity) return;
        panel.recent(
          (await engine.store.list()).sort((a, b) => b.target.date.localeCompare(a.target.date)).slice(0, 7),
        );
      }),
    export: () => viewing.diagnosticExport(),
    observe: (code) => {
      if (viewing) viewing.observePage(code);
    },
  });
  dayCheck();
  const suspend = (code = "FOREGROUND_REQUIRED") => {
    if (current.formal) void current.suspend(code);
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") suspend();
    else dayCheck();
  });
  document.addEventListener("freeze", () => suspend());
  window.addEventListener("pagehide", () => {
    viewing.observePage("PAGE_CONTEXT_END");
    suspend();
  });
  window.addEventListener("storage", () => {
    if (current.formal && current.store.stopped()) void current.suspend();
  });
  const loop = () => {
    dayCheck();
    if (!current.formal && current.state === "IDLE" && Date.now() >= current.task.open)
      current.emit("EXPIRED", "PREPARE_WINDOW");
    panel.clock(current.task, Date.now());
    void current.tick();
    setTimeout(loop, current.waiting && current.task.open - Date.now() <= 2000 ? 50 : 250);
  };
  loop();
}
