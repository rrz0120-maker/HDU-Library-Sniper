import { build } from "vite";
import { readFile, writeFile } from "node:fs/promises";
const path = "userscripts/hdu-p53-2000-single.user.js";
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
      entry: "src/userscript/p53/entry.js",
      name: "HduP53",
      formats: ["iife"],
      fileName: () => "hdu-p53-2000-single.user.js",
    },
  },
});
const metadata = `// ==UserScript==
// @name         杭电图书馆 P5.3 四楼162单次整点预约
// @namespace    https://github.com/rrz0120-maker/HDU-Library-Sniper/p53
// @version      5.3.0
// @description  默认只读；明确启用2026-11-17正式任务后，20:00合法开放再单次预约11-19四楼162 08:00–22:00；无重试、无其他座位、无预锁。
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
  throw new Error("Invalid P5.3 artifact");
await writeFile(path, code);
console.log(`${path} (${Buffer.byteLength(code)} bytes)`);
