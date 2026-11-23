import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { build } from "vite";

const file = "HDU_Android_P6.2_Lite.user.js";
await build({
  configFile: false,
  publicDir: false,
  logLevel: "warn",
  build: {
    target: "firefox115",
    minify: false,
    emptyOutDir: false,
    outDir: "userscripts",
    lib: { entry: "src/userscript/p60/entry.js", name: "HduP62", formats: ["iife"], fileName: () => file },
  },
});
const metadata = [
  "// ==UserScript==",
  "// @name         杭电图书馆 Android P6.2 Lite",
  "// @namespace    https://github.com/rrz0120-maker/HDU-Library-Sniper/p62",
  "// @version      6.2.0",
  "// @description  四楼162号，默认北京时间20:00:01.350预约后天08:00–22:00；一次正式POST与官方记录核验。",
  "// @match        https://hdu.huitu.zhishulib.com/*",
  "// @grant        none",
  "// @noframes",
  "// @run-at       document-end",
  "// @updateURL    none",
  "// @license      MIT",
  "// ==/UserScript==",
].join("\n");
const path = `userscripts/${file}`;
const code = `${metadata}\n${await readFile(path, "utf8")}`;
if (
  /@require|GM_xmlhttpRequest|document\.cookie|OPEN_RANGE_|openProofGeneration|openingChecks|nextOpeningCheckMono/.test(
    code,
  )
)
  throw new Error("Forbidden legacy gate or dependency in P6.2");
await writeFile(path, code);
execFileSync("python3", [
  "-c",
  [
    "from pathlib import Path",
    "from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED",
    "with ZipFile('userscripts/HDU_Android_P6.2_Lite.zip','w',compression=ZIP_DEFLATED) as out:",
    ` for source, name in [('userscripts/${file}','${file}'),('docs/P62-ANDROID-LITE.md','安装说明.md'),('LICENSE','LICENSE')]:`,
    "  item = ZipInfo(name, (2026,11,23,0,0,0))",
    "  item.compress_type = ZIP_DEFLATED",
    "  item.external_attr = 0o100644 << 16",
    "  out.writestr(item,Path(source).read_bytes())",
  ].join("\n"),
]);
const outputs = [file, "HDU_Android_P6.2_Lite.zip"];
const sums = (await readFile("userscripts/SHA256SUMS", "utf8"))
  .trimEnd()
  .split("\n")
  .filter((line) => !outputs.some((name) => line.endsWith(`  ${name}`)));
for (const name of outputs) {
  const bytes = await readFile(`userscripts/${name}`);
  sums.push(`${createHash("sha256").update(bytes).digest("hex")}  ${name}`);
  console.log(`${name} (${bytes.length} bytes)`);
}
await writeFile("userscripts/SHA256SUMS", `${sums.join("\n")}\n`);
