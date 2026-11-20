import { ORIGIN } from "../core.js";
import { Transport } from "../transport.js";
import { IpadStore } from "./store.js";
import { IpadBookingEngine } from "./engine.js";
import { mountIpadPanel } from "./panel.js";

function bootIpadP70() {
  if (
    location.origin !== ORIGIN ||
    window.top !== window.self ||
    window.__HDU_P70_MOUNTED__ ||
    document.getElementById("hdu-p70-host")
  )
    return;
  window.__HDU_P70_MOUNTED__ = true;
  const store = new IpadStore();
  const engine = new IpadBookingEngine(new Transport(), store);
  mountIpadPanel(engine);

  const suspend = () => engine.suspend("FOREGROUND_REQUIRED");
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") suspend();
  });
  window.addEventListener("pagehide", suspend);
  window.addEventListener("storage", (event) => {
    if (event.key === `${store.prefix}stop`) engine.suspend("STOPPED");
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootIpadP70, { once: true });
} else {
  bootIpadP70();
}
