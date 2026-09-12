import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { runInNewContext } from "node:vm";

// Exercise the real desktop turn finalizer, without booting Electron or making a
// provider request. Source-text assertions cannot see scoping, throwing or
// ordering defects in this function, so it is extracted and executed instead.
const main = await readFile(
  new URL("../electron/main/index.ts", import.meta.url),
  "utf8",
);
const start = main.indexOf("function finishTurn(");
const end = main.indexOf("async function finishApprovedExecution(", start);
assert.ok(start >= 0 && end > start, "finishTurn must be locatable");
const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
// The abort reason lock and the turn-key helpers are module state that the
// finalizer, the dispatch gate and the persistence path all consult, so they
// are extracted and executed together with it.
const helpersStart = main.indexOf("function turnKey(");
const helpersEnd = main.indexOf("function announceTurnEnded(", helpersStart);
const abortStart = main.indexOf("const pendingAbortReasons");
const abortEnd = main.indexOf("function addActiveTurnUsage(", abortStart);
assert.ok(
  helpersStart >= 0 && helpersEnd > helpersStart,
  "turn key helpers must be locatable",
);
assert.ok(
  abortStart >= 0 && abortEnd > abortStart,
  "the abort reason lock must be locatable",
);
const support = transpile(
  `${main.slice(helpersStart, helpersEnd)}\n${main.slice(abortStart, abortEnd)}`,
);
const finalizer = transpile(main.slice(start, end));
const api = `${support}\n${finalizer}\n;({ finishTurn, takeAbortReason, lockAbortReason })`;

/**
 * The finalizer is a closure over module state, so each case gets its own
 * context with the same collaborators and records what the host was asked to do.
 */
function fixture({ active = new Map([["s1", "t1"]]), endTurn } = {}) {
  const announcements = [];
  const kicks = [];
  const calls = [];
  const context = {
    activeTurns: active,
    turnFinalizations: new Map(),
    activeTurnUsages: new Map(),
    planSubmissionTurnIds: new Set(),
    turnSettlements: new Map(),
    scheduledRunsBySession: new Map(),
    activeToolCalls: new Map(),
    pendingAbortReasons: new Map(),
    turnKey: (sessionId, turnId) => `${sessionId}:${turnId ?? ""}`,
    planSubmissionTurnKey: (sessionId, turnId) => `${sessionId}:${turnId}`,
    isActiveTurn: (sessionId, turnId) =>
      Boolean(turnId) && active.get(sessionId) === turnId,
    shouldCreateTaskNotification: () => false,
    logger: { app() {} },
    sendToRenderer() {},
    emitAgentEvent() {},
    IPC: { event: { notificationChanged: "notificationChanged" } },
    // The finalizer defers tool-call metadata cleanup; keep it from running.
    setTimeout: () => ({ unref() {} }),
    quitting: false,
    agentHostBridge: { agentHost: { kick: (id) => kicks.push(id) } },
    announceTurnEnded: (sessionId, turnId, reason) =>
      announcements.push({ sessionId, turnId, reason }),
    host: {
      async call(method, params) {
        calls.push({ method, params });
        if (method === "session.endTurn" && endTurn) return endTurn();
        return { ok: true };
      },
    },
  };
  const exposed = runInNewContext(api, context);
  assert.equal(typeof exposed.finishTurn, "function");
  assert.equal(typeof exposed.takeAbortReason, "function");
  assert.equal(typeof exposed.lockAbortReason, "function");
  return {
    active,
    announcements,
    calls,
    context,
    finishTurn: exposed.finishTurn,
    kicks,
    lockAbortReason: exposed.lockAbortReason,
    takeAbortReason: exposed.takeAbortReason,
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a turn end is announced once, with its terminal reason", async () => {
  const f = fixture();
  await f.finishTurn("s1", "completed", undefined, { turnId: "t1" });
  assert.deepEqual(f.announcements, [
    { sessionId: "s1", turnId: "t1", reason: "completed" },
  ]);
});

test("a terminal event without a turn identity settles nothing", async () => {
  const f = fixture();
  // Callers chain on the result, so the no-op path must still be a promise:
  // `await undefined` would hide a broken contract here.
  const promise = f.finishTurn("s1", "error", "BOOM", {});
  assert.ok(
    promise && typeof promise.then === "function",
    "a no-op finalization returns a thenable",
  );
  await promise;
  assert.equal(f.announcements.length, 0);
  assert.equal(f.calls.length, 0, "no persistence without an identity");
});

test("a terminal event for a turn that lost its session is ignored", async () => {
  const f = fixture({ active: new Map([["s1", "t2"]]) });
  const promise = f.finishTurn("s1", "error", "LATE", { turnId: "t1" });
  assert.ok(
    promise && typeof promise.then === "function",
    "an ignored turn end returns a thenable",
  );
  await promise;
  assert.equal(f.announcements.length, 0);
  assert.equal(f.calls.length, 0, "a stale turn must not reach persistence");
  assert.equal(f.active.get("s1"), "t2", "the newer turn keeps ownership");
});

test("a failed durable endTurn still announces the turn end", async () => {
  const f = fixture({
    endTurn: () => {
      throw new Error("host unavailable");
    },
  });
  await f.finishTurn("s1", "completed", undefined, { turnId: "t1" });
  assert.deepEqual(
    f.announcements.map((a) => a.reason),
    ["completed"],
  );
});

test("a repeated terminal event for the same turn does not announce twice", async () => {
  const f = fixture();
  await f.finishTurn("s1", "aborted", "TURN_ABORTED", { turnId: "t1" });
  await f.finishTurn("s1", "completed", undefined, { turnId: "t1" });
  assert.equal(f.announcements.length, 1);
  assert.equal(f.announcements[0].reason, "aborted");
});

test("the host queue is kicked once the finalization is released", async () => {
  const f = fixture();
  await f.finishTurn("s1", "completed", undefined, { turnId: "t1" });
  await settle();
  assert.deepEqual(f.kicks, ["s1"]);
});

test("a stale turn does not settle a newer turn's session-keyed state", async () => {
  const f = fixture({ active: new Map([["s1", "t2"]]) });
  f.context.activeTurnUsages.set("s1", { inputTokens: 5 });
  f.context.scheduledRunsBySession.set("s1", "run-of-t2");
  await f.finishTurn("s1", "error", "STALE", { turnId: "t1" });
  assert.equal(f.context.activeTurnUsages.get("s1")?.inputTokens, 5);
  assert.equal(f.context.scheduledRunsBySession.get("s1"), "run-of-t2");
});

// A terminal event that cannot be attributed to a turn must not consume that
// turn's locked abort reason. Taking it would make the cancelled turn look
// cancellable again (so its tools would keep dispatching) and its own terminal
// event would then report the wrong reason.
test("an unattributable terminal event does not consume the abort reason", () => {
  const f = fixture();
  f.lockAbortReason("s1", "t1");
  assert.equal(
    f.takeAbortReason("s1", undefined),
    undefined,
    "an event with no identity has no lock to take",
  );
  assert.equal(
    f.takeAbortReason("s1", "t1"),
    "aborted",
    "the cancelled turn keeps its locked reason",
  );
});

test("a locked reason is consumed only by the turn that locked it", () => {
  const f = fixture();
  f.lockAbortReason("s1", "t1");
  assert.equal(f.takeAbortReason("s1", "t2"), undefined, "another turn cannot take it");
  assert.equal(f.takeAbortReason("s1", "t1"), "aborted");
});
