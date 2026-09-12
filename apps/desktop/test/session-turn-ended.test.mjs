import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [main, pluginRuntime, pluginHost, sidecar, rpcMod, toolsMod, apiEn, apiZh] =
  await Promise.all([
    read("../electron/main/index.ts"),
    read("../electron/main/plugin-runtime.ts"),
    read("../electron/main/plugin-host-process.mjs"),
    read("../electron/main/agent-sidecar.ts"),
    read("../../../crates/host-core/src/rpc/mod.rs"),
    read("../../../crates/host-core/src/tools/mod.rs"),
    read("../../../docs/spec/07-plugins/03-plugin-api.md"),
    read("../../../docs/zh-CN/spec/07-plugins/03-plugin-api.md"),
  ]);

// The event is host-owned: `finishTurn` is the single place a host turn reaches
// its terminal state, so that is where the announcement belongs.
test("turn end is announced from the single turn finalizer", () => {
  assert.match(main, /function announceTurnEnded\(/);
  // Announced from the finalizer's `finally`: a failing persistence step above
  // must not be able to suppress it, and local ownership is already released.
  const finalizer = main.slice(main.indexOf("function finishTurn("));
  const finallyAt = finalizer.indexOf("} finally {");
  const announceAt = finalizer.indexOf(
    "announceTurnEnded(sessionId, turnId, status);",
  );
  assert.ok(finallyAt > -1, "the finalizer must release local state in a finally");
  assert.ok(announceAt > finallyAt, "the announcement must run inside the finally");
});

test("turn end payload carries session, turn and terminal reason", () => {
  assert.match(main, /name: "session:turnEnded"|"session:turnEnded"/);
  assert.match(main, /const payload = \{ sessionId, turnId, reason \};/);
  assert.match(main, /plugins\.broadcastEvent\("session:turnEnded", \[payload\]\)/);
  assert.match(main, /broadcastPluginPanelEvent\("session:turnEnded", payload\)/);
});

// Once per turn, and only once. A turn can deliver more than one terminal event
// (an abort is followed by an agent_end), so the finalizer refuses to run for a
// turn that no longer owns its session and shares one finalization per
// (sessionId, turnId). No marker outlives the turn: an expiring one re-announced
// the same turn once its TTL elapsed.
test("turn end is emitted at most once per turn identity", () => {
  assert.match(main, /function turnKey\(sessionId: string, turnId\?: string\)/);
  assert.match(
    main,
    /if \(!turnId \|\| !isActiveTurn\(sessionId, turnId\)\) return Promise\.resolve\(\);/,
  );
  assert.doesNotMatch(
    main,
    /announcedTurns|ANNOUNCED_TURN_TTL_MS|ANNOUNCED_TURN_LIMIT|pruneAnnouncedTurns/,
  );
});

// Identity comes from the terminal event, not from whichever turn is active,
// so a late event for an earlier turn cannot settle a newer one.
test("turn finalization keys dedup by (sessionId, turnId)", () => {
  assert.match(main, /const turnId = options\.turnId;/);
  assert.doesNotMatch(main, /options\.turnId \?\? activeTurns\.get\(sessionId\)/);
  assert.match(main, /const finalizationKey = turnKey\(sessionId, turnId\);/);
  assert.match(main, /turnFinalizations\.get\(finalizationKey\)/);
  assert.match(main, /turnFinalizations\.set\(finalizationKey, finalization\)/);
  assert.match(main, /turnFinalizations\.delete\(finalizationKey\)/);
  // Terminal events pass the identity they were delivered with.
  assert.match(main, /\{ turnId: envelope\.turnId \}/);
});

// Session-keyed state must not be settled by a turn that no longer owns the
// session, or a late event for an old turn steals the new turn's usage and
// closes its scheduled run.
test("session-keyed side effects are gated on turn ownership", () => {
  assert.match(main, /const ownsSession = activeTurns\.get\(sessionId\) === turnId;/);
  assert.match(
    main,
    /const turnUsage = ownsSession \? activeTurnUsages\.get\(sessionId\) : undefined;/,
  );
  assert.match(main, /if \(ownsSession\) activeTurnUsages\.delete\(sessionId\);/);
  assert.match(
    main,
    /const runId = ownsSession \? scheduledRunsBySession\.get\(sessionId\) : undefined;/,
  );
});

// The locked abort reason must survive its own finalizer, because the terminal
// event it guards can arrive after that finalization already settled.
test("abort reason outlives turn teardown and is consumed on read", () => {
  assert.match(main, /pendingAbortReasons\.set\(turnKey\(sessionId, active\), "aborted"\);/);
  assert.match(main, /pendingAbortReasons\.delete\(key\);\n\s*return "aborted";/);
  assert.doesNotMatch(
    main,
    /finally \{[\s\S]{0,600}?pendingAbortReasons\.delete/,
  );
  // The read takes the lock for one turn only. An event that carries no turn id
  // cannot be attributed, so it must not consume the active turn's decision.
  assert.match(main, /if \(!turnId\) return undefined;/);
  assert.match(main, /const key = turnKey\(sessionId, turnId\);/);
  assert.doesNotMatch(
    main,
    /turnKey\(sessionId, turnId \?\? activeTurns\.get\(sessionId\)\)/,
  );
});

// An abort locks its reason before the cancel RPC awaits, so an agent_end that
// lands inside that window cannot restate the abort as a completion.
test("abort reason is locked before the cancel request", () => {
  assert.match(main, /const pendingAbortReasons = new Map<string, "aborted">\(\);/);
  assert.match(main, /function lockAbortReason\(sessionId: string, turnId\?: string\)/);
  assert.match(main, /function takeAbortReason\(/);
  const abortHandler = main.slice(main.indexOf("IPC.invoke.agentAbort"));
  const lockAt = abortHandler.indexOf("lockAbortReason(req.sessionId, abortTurnId)");
  const awaitAt = abortHandler.indexOf('await sidecar.call("agent.abort", req)');
  assert.ok(lockAt > -1, "abort handler must lock the reason");
  assert.ok(awaitAt > -1, "abort handler must still issue the cancel RPC");
  assert.ok(lockAt < awaitAt, "the reason must be locked before the first await");
  // agent_end honours a locked abort instead of forcing completion.
  assert.match(main, /const completedReason = takeAbortReason\(/);
  assert.match(main, /completedReason \?\? "completed"/);
});

// Transport: the runtime has always sent the turn id and the plugin host has
// always read it; the two hops in between used to drop it.
test("plugin tool context receives the runtime turn id end to end", () => {
  assert.match(rpcMod, /"turnId": p\.turn_id,/);
  assert.match(toolsMod, /pub turn_id: Option<String>,/);
  assert.match(sidecar, /turnId\?: string;/);
  assert.match(sidecar, /\{ turnId: params\.turnId\.trim\(\) \}/);
  assert.match(main, /turnId: q\.turnId,/);
  assert.match(pluginRuntime, /turnId\?: string;/);
  assert.match(pluginRuntime, /\{ turnId: ctx\.turnId \}/);
  assert.match(pluginHost, /turnId: payload\?\.turnId,/);
});

// No new permission: the event rides the existing one-way channel, and a
// throwing recipient must not starve the others.
test("turn end reuses the existing event channel without a new permission", () => {
  assert.doesNotMatch(main, /session:turnEnded[\s\S]{0,200}permission/i);
  assert.match(
    pluginRuntime,
    /broadcastEvent\(event: string, args: unknown\[\] = \[\]\): void \{\s*\n\s*for \(const loaded of this\.loaded\.values\(\)\) \{\s*\n\s*try \{/,
  );
});

test("api docs document the event, its limits and both locales", () => {
  for (const doc of [apiEn, apiZh]) {
    assert.match(doc, /session:turnEnded/);
    assert.match(doc, /turnId/);
  }
  assert.match(apiEn, /aborted/);

// A terminal event that cannot be attributed to the current turn must not reach
// the Agent Host or the renderer, and a plugin dispatch must not start once the
// turn is cancelled or already finalizing.
test("both gates reject an event or dispatch that is not the live turn", () => {
  assert.match(
    main,
    /return !envelope\.turnId \|\| active !== envelope\.turnId;/,
  );
  assert.match(
    main,
    /!pendingAbortReasons\.has\(turnKey\(gateSessionId, q\.turnId\)\)/,
  );
  assert.match(
    main,
    /!turnFinalizations\.has\(turnKey\(gateSessionId, q\.turnId\)\)/,
  );
});
  // The no-replay limit is the honest part of the contract.
  assert.match(apiEn, /replay|no replay|not replayed|fire-and-forget/i);
});
