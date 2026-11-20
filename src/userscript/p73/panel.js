import { mountP71Panel } from "../p71/panel.js";

// Thin P7.3 UI wrapper around proven P7.1.1 Shadow DOM panel:
// - Updates branding & 19:57 operational guidance
// - Suppresses non-critical live log textarea JSON serialization during 20:00 hot path
// - Disables tab switching while scheduled task is actively PREPARING/WAITING/SUBMITTING
export function mountP73Panel(actions, normalEngine) {
  const panel = mountP71Panel(actions, normalEngine);
  const el = (id) => panel.root.getElementById(id);

  const heading = panel.root.querySelector("h2");
  if (heading) heading.textContent = "P7.3 iPad 正式性能版 · 162整点 & 普通预约";

  const startBtn = el("sStartBtn");
  if (startBtn) startBtn.textContent = "启动20:00待命（建议19:57正式启动 · 未勾选=只读预检）";

  const hints = panel.root.querySelectorAll("#paneSched .hint");
  if (hints.length >= 3) {
    hints[2].textContent =
      "建议19:57起正式待命（19:55起已开放窗口）；19:59:15自动重校时。保持Safari前台与屏幕常亮，切后台/锁屏自动中止不补发。";
  }

  let lastRenderSig = "";
  const origRender = panel.renderScheduled;
  panel.renderScheduled = (view) => {
    const inHotPath =
      view.state === "SUBMITTING" ||
      view.state === "VERIFYING" ||
      (view.state === "WAITING" &&
        ["OPEN_RANGE_CHECKING", "OPEN_RANGE_CONFIRMED", "RECALIBRATING_CLOCK"].includes(view.reason));

    const sig = `${view.task.day}:${view.task.startHour}-${view.task.endHour}:${view.state}:${view.reason}:${view.formal}`;
    if (sig === lastRenderSig) return;
    lastRenderSig = sig;

    const tabNormal = el("tabNormal");
    if (tabNormal) tabNormal.disabled = view.formal || view.waiting || view.state === "PREPARING";

    // Prevent heavy JSON.stringify DOM updates on the hot 20:00 release path.
    const logBox = el("sLogText");
    const wasLogOpen = logBox && !logBox.hidden;
    if (inHotPath && wasLogOpen) {
      logBox.hidden = true;
      actions.onUiSuppressed?.();
    }
    origRender(view);
  };

  return panel;
}
