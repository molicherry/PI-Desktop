# ADR 0235: Host turn-end event for plugins

- Status: Accepted
- Date: 2026-09-12
- Deciders: PI-Desktop core
- Related: [D407](../spec/08-meta/decisions-log.md) · [ADR 0005](0005-user-installable-plugin-system.md) · [ADR 0040](0040-plugin-resident-services-and-message-bus.md) · [ADR 0213](0213-persist-host-owned-turn-queue.md) · `07-plugins/03-plugin-api.md` · `07-plugins/13-plugin-permissions-matrix.md`

## Context

A plugin that drives a GUI — a notification surface, a launcher, a work-panel
view — can already observe `workspace:changed`, `plugin:settingsChanged`, and
`session:modelChanged`, but nothing told it when the host turn it was reacting
to had actually finished. Plugins fell back to idle timers, which are wrong in
both directions: they fire during a long tool call, and they fire again for a
turn that ended moments earlier.

The host already owns this fact. One turn teardown path resolves the durable
`session.endTurn` row with `completed`, `aborted`, or `error` for the turn
created by `session.beginTurn`. What was missing was a published identity and a
published boundary: `ToolExecContext` declared `turnId`, but the host never
populated it, so a plugin could not correlate a late tool result with the turn
that requested it.

## Decision

1. **`session:turnEnded` is a host event.** Payload is
   `{ sessionId: string; turnId: string; reason: "completed" | "aborted" | "error" }`,
   delivered to plugin processes exactly like `workspace:changed` and
   `session:modelChanged`, and (like `workspace:changed`) to plugin panel pages.

2. **Once per turn actually started.** The event is emitted at the end of turn
   teardown, after the durable `session.endTurn` attempt, and only for a turn
   created by `session.beginTurn`: a user submission, an approved plan
   execution, or a scheduled run. A queued item that never started produces no
   event. The announcement dedupes on `(sessionId, turnId)`.

3. **Turn identity is authoritative.** The emitted `turnId` is the identity the
   terminal runtime event carried, not whichever turn happens to be active, so
   a late terminal event from an earlier turn cannot settle a newer one. Plugin
   tool contexts are populated with the same `turnId`.

4. **No new permission.** The event travels on the existing plugin event
   channel to every loaded plugin, and subscribing to an unknown event name does
   not error.

Explicit non-promises: there is no ack and no replay. The host broadcasts once
per started turn; a plugin that is alive and subscribed receives it once.
Delivery that races a plugin crash, reload, or host quit is not guaranteed, and
receiving the event does not mean that every in-flight tool of that turn has
exited — late results can still arrive, so cleanup must be serialised or scoped
by `turnId`.

## Consequences

- Plugins settle turn-scoped UI, notifications, and bookkeeping from the host's
  own terminal state instead of guessing with idle timers.
- The event bounds the turn, not the individual tool calls, so a plugin must
  still treat late tool results as valid.
- Turn-scoped cleanup that ignores `turnId` can settle the wrong turn;
  `ToolExecContext.turnId` now makes correct scoping possible.
- Hosts before 0.14.7 never emit the event, so a plugin that depends on it must
  require that minimum host version.

## Alternatives rejected

### Poll a session API for the active turn

Reading session state on a timer would need `session.read`, would hand a plugin
the conversation it does not otherwise see, and would still leave the end
boundary to guesswork — the event carries no more than the identity and reason
the host already owns.

### Release the plugin per invocation

Unloading a plugin when its turn ends ties turn end to a lifecycle event that
also has to survive reload, crash, and quit, and would drop the resident
services and panel state a plugin holds across turns.

### Raise the idle timeout

A longer silence threshold detects turn end later and still cannot distinguish
"a tool is thinking" from "the turn is over"; it also delays exactly the
completion signal a GUI plugin exists to deliver.

## References

- `apps/desktop/electron/main/index.ts` — `announceTurnEnded`, `finishTurn`
- `apps/desktop/electron/main/plugin-runtime.ts` — `broadcastEvent`
