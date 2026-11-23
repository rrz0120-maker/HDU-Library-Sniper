import test from "node:test";
import assert from "node:assert/strict";
import { BOOK_PATH, ORIGIN, signedRequest } from "../../src/userscript/core.js";
import { Transport } from "../../src/userscript/transport.js";

const options = () => ({
  write: true,
  inspectHttpErrors: true,
  ...signedRequest("62726", "111", 1795478400, 1795348801, 50400),
});

test.beforeEach(() => {
  globalThis.location = { origin: ORIGIN };
});
test.afterEach(() => {
  delete globalThis.location;
});

test("dispatchAt is captured after the intent, before any observation or UI work", async (t) => {
  let wall = 100000,
    fetchAt;
  t.mock.method(Date, "now", () => wall);
  t.mock.method(globalThis, "fetch", (_, init) => {
    fetchAt = wall;
    assert.equal(init.credentials, "same-origin");
    assert.equal(init.body.get("duration"), "50400");
    return Promise.resolve(new Response('{"CODE":"ok","DATA":{"result":"success"}}'));
  });
  let stamped;
  const result = await new Transport().request(BOOK_PATH, {
    ...options(),
    beforeDispatch: () => {
      wall += 145;
    },
    onDispatched: (at) => {
      stamped = at;
      wall += 800;
    },
  });
  assert.equal(Date.parse(stamped), fetchAt);
  assert.equal(Date.parse(result.timing.dispatchAt), 100145);
});

test("synchronous fetch rejection has no dispatch timestamp or sent notification", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw TypeError("blocked");
  });
  let attempts = 0;
  await assert.rejects(
    new Transport().request(BOOK_PATH, { ...options(), onDispatched: () => attempts++ }),
    (e) => e.timing.dispatchAt === null,
  );
  assert.equal(attempts, 0);
});

test("an observation exception cannot consume a successful server reply", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(new Response('{"CODE":"ok","DATA":{"result":"success"}}')),
  );
  const r = await new Transport().request(BOOK_PATH, {
    ...options(),
    onDispatched: () => {
      throw Error("UI");
    },
  });
  assert.equal(r.body.DATA.result, "success");
  assert.equal(r.timing.observationError, true);
});

test("HTTP 404 preserves HTTP status, business NotFound and exact text", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(new Response('{"CODE":"NotFound","MESSAGE":"馆方繁忙"}', { status: 404 })),
  );
  const r = await new Transport().request(BOOK_PATH, options());
  assert.equal(r.status, 404);
  assert.equal(r.body.CODE, "NotFound");
  assert.equal(r.body.MESSAGE, "馆方繁忙");
});

test("legacy callers retain HTTP error behavior", async (t) => {
  t.mock.method(globalThis, "fetch", () => Promise.resolve(new Response("{}", { status: 404 })));
  await assert.rejects(new Transport().request(BOOK_PATH, { ...options(), inspectHttpErrors: false }), {
    code: "HTTP_404",
  });
});

test("429 is visible at headers before a body arrives and Retry-After survives parsing", async (t) => {
  let release,
    observed = false;
  const stream = new ReadableStream({
    start(ctrl) {
      release = () => {
        ctrl.enqueue(new TextEncoder().encode('{"CODE":"LIMITED"}'));
        ctrl.close();
      };
    },
  });
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(new Response(stream, { status: 429, headers: { "Retry-After": "901" } })),
  );
  const pending = new Transport().request(BOOK_PATH, {
    ...options(),
    onHeaders: (sample) => {
      observed = true;
      assert.equal(sample.status, 429);
      assert.equal(sample.retryAfter, "901");
    },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(observed, true);
  release();
  const r = await pending;
  assert.equal(r.body.CODE, "LIMITED");
  assert.equal(r.retryAfter, "901");
});

for (const kind of ["before headers", "during body"])
  test(`30s timeout ${kind} keeps one actual dispatch and unknown outcome`, async (t) => {
    let timeout;
    const original = setTimeout;
    t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => {
      if (ms === 30000) {
        timeout = fn;
        return 0;
      }
      return original(fn, ms, ...args);
    });
    const fetch = t.mock.method(globalThis, "fetch", (_, init) => {
      if (kind === "before headers")
        return new Promise((_, reject) =>
          init.signal.addEventListener("abort", () => reject(Error("abort"))),
        );
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () =>
          new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Error("abort")))),
      });
    });
    let count = 0;
    const pending = new Transport().request(BOOK_PATH, { ...options(), onDispatched: () => count++ });
    await new Promise((r) => setImmediate(r));
    timeout();
    await assert.rejects(pending, (e) => e.code === "TIMEOUT" && !!e.timing.dispatchAt);
    assert.equal(count, 1);
    assert.equal(fetch.mock.callCount(), 1);
  });

test("network rejection records one hand-off, zero retries", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", () => Promise.reject(new TypeError("offline")));
  await assert.rejects(
    new Transport().request(BOOK_PATH, options()),
    (e) => e.code === "NETWORK_ERROR" && !!e.timing.dispatchAt,
  );
  assert.equal(fetch.mock.callCount(), 1);
});
