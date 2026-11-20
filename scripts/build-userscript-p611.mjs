import { build } from "vite";
import { readFile, writeFile } from "node:fs/promises";
const path = "userscripts/hdu-p611-history-recovery.user.js";
await build({
  configFile: false,
  publicDir: false,
  logLevel: "warn",
  build: {
    target: "firefox115",
    minify: false,
    emptyOutDir: false,
    outDir: "userscripts",
    lib: {
      entry: "src/userscript/p60/entry.js",
      name: "HduP611",
      formats: ["iife"],
      fileName: () => "hdu-p611-history-recovery.user.js",
    },
  },
});
const metadata = `// ==UserScript==
// @name         杭电图书馆 P6.1 Lite 每日162
// @namespace    https://github.com/rrz0120-maker/HDU-Library-Sniper/p61
// @version      6.1.1
// @description  默认只读；每日明确授权，20:00且馆方日期核验后最多一次预约后天四楼162 08:00–22:00；实时悬浮反馈，不重试不换座。
// @match        https://hdu.huitu.zhishulib.com/*
// @grant        none
// @noframes
// @run-at       document-idle
// @updateURL    none
// @license      MIT
// ==/UserScript==
`;
const code = metadata + (await readFile(path, "utf8"));
if (/@require|GM_xmlhttpRequest|document\.cookie|lockSeats|cancelBooking|signIn/.test(code))
  throw new Error("Invalid P6.1.1 artifact");
await writeFile(path, code);
console.log(`${path} (${Buffer.byteLength(code)} bytes)`);
