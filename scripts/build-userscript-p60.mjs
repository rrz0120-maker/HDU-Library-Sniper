// Restore the frozen successful artifact from its pinned source commit.
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
const path = "userscripts/hdu-p60-lite.user.js";
await writeFile(path, execFileSync("git", ["show", `4313031b6c5059003314de482207ba539e1b06ca:${path}`]));
console.log(`${path} restored from the P6.1.1 baseline`);
