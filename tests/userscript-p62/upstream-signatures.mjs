import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signedRequest } from "../../src/userscript/core.js";
import { dailyTask } from "../../src/userscript/p60/policy.js";

const upstream = process.argv[2];
if (!upstream) throw new Error("Pass a local clone of AlaIchhe/HDU-Library-Sniper");
const ref = "f1055c9713c7b5917c4ef4d6d1c959864e41f05c";
const source = execFileSync("git", ["-C", upstream, "show", `${ref}:internal/hdu/crypto.go`]);
const vectors = JSON.parse(readFileSync("tests/fixtures/p53-signatures.json"));
for (let startHour = 7; startHour < 22; startHour++) {
  for (let endHour = startHour + 1; endHour <= 22; endHour++) {
    const task = dailyTask(Date.parse("2026-11-22T19:59:00+08:00"), { startHour, endHour });
    const v = {
      seatId: task.seatId,
      uid: "111",
      beginTime: task.begin,
      duration: task.duration,
      apiTime: task.open / 1000 + 1,
    };
    v.token = signedRequest(v.seatId, v.uid, v.beginTime, v.apiTime, v.duration).token;
    vectors.push(v);
  }
}
const folder = mkdtempSync(join(tmpdir(), "p62-upstream-"));
try {
  writeFileSync(join(folder, "crypto.go"), source);
  writeFileSync(join(folder, "vectors.json"), JSON.stringify(vectors));
  writeFileSync(
    join(folder, "oracle_test.go"),
    [
      "package hdu",
      'import ("testing"; "os"; "encoding/json")',
      "func TestP62(t *testing.T) {",
      'data, err := os.ReadFile("vectors.json"); if err != nil { t.Fatal(err) }',
      "var rows []struct { SeatID, UID, Token string; BeginTime, Duration, ApiTime int64 }",
      "if err := json.Unmarshal(data, &rows); err != nil { t.Fatal(err) }",
      'for i,r := range rows { if ApiToken(r.SeatID,r.UID,r.BeginTime,r.Duration,r.ApiTime) != r.Token { t.Fatalf("vector %d",i) } }',
      't.Logf("%d exact upstream signature matches", len(rows))',
      "}",
    ].join("\n"),
  );
  execFileSync(process.env.GO_BINARY || "go", ["test", "-v", "crypto.go", "oracle_test.go"], {
    cwd: folder,
    env: { ...process.env, GO111MODULE: "off" },
    stdio: "inherit",
  });
} finally {
  rmSync(folder, { recursive: true, force: true });
}
