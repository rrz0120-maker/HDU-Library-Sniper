import { build } from "vite";
import { readFile, writeFile, mkdir } from "node:fs/promises";
const metadata = `// ==UserScript==
// @name         杭电图书馆 P5.1 单次预约测试
// @namespace    https://github.com/rrz0120-maker/HDU-Library-Sniper
// @version      5.1.0
// @description  官网同源只读检查与明确确认后单次预约；不自动重试、不取消、不提供20:00定时模式。
// @match        https://hdu.huitu.zhishulib.com/*
// @grant        none
// @noframes
// @run-at       document-idle
// @updateURL    none
// @license      MIT
// ==/UserScript==
`;
await mkdir("userscripts", { recursive: true });
await build({
  configFile: false,
  logLevel: "warn",
  build: {
    target: "firefox115",
    minify: false,
    emptyOutDir: false,
    outDir: "userscripts",
    lib: {
      entry: "src/userscript/entry.js",
      name: "HduP51",
      formats: ["iife"],
      fileName: () => "hdu-p51.user.js",
    },
    rollupOptions: { output: {} },
  },
});
const code = metadata + (await readFile("userscripts/hdu-p51.user.js", "utf8"));
if (!code.startsWith("// ==UserScript==") || /@require|GM_xmlhttpRequest|document\.cookie/.test(code))
  throw new Error("Invalid userscript delivery");
await writeFile("userscripts/hdu-p51.user.js", code);
console.log(`userscripts/hdu-p51.user.js (${Buffer.byteLength(code)} bytes)`);
