import assert from "node:assert/strict";
import test from "node:test";
import { BOOK_PATH, ORIGIN, signedRequest } from "../../src/userscript/core.js";
import { publicDiagnostics } from "../../src/userscript/p60/policy.js";
import { Transport } from "../../src/userscript/transport.js";

for (const count of [0, 1, 2]) {
  test(`network phases require a unique Resource Timing entry (found ${count})`, async (t) => {
    t.after(() => {
      delete globalThis.location;
    });
    globalThis.location = { origin: ORIGIN };
    t.mock.method(performance, "now", () => 100);
    t.mock.method(performance, "getEntriesByName", () =>
      Array(count).fill({
        initiatorType: "fetch",
        startTime: 100,
        requestStart: 101,
        responseStart: 111,
        responseEnd: 114,
      }),
    );
    t.mock.method(globalThis, "fetch", async () => new Response("{}"));
    const result = await new Transport().request(BOOK_PATH, {
      ...signedRequest("62726", "111", 1795478400, 1795348801, 50400),
      write: true,
    });
    const row = publicDiagnostics(result.timing);
    assert.equal(row.requestToFirstByteMs, count === 1 ? 10 : null);
    assert.equal(row.responseDownloadMs, count === 1 ? 3 : null);
    assert.equal(row.requestStartAt !== null, count === 1);
  });
}
