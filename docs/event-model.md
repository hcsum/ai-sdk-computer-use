# Event model

Design notes for the dashboard's event pipeline: what is stored, what is derived,
and which invariants the implementation has to hold. Written before the pipeline
was built, so it doubles as the spec for it.

## Three layers

```text
Session    = messages + lifecycleEvents + sandboxId
ToolEvents = derive(messages, keyed by toolCallId)
TurnEvents = derive(messages, keyed by messageId)
AllEvents  = lifecycleEvents + ToolEvents + TurnEvents
```

**`messages`** is the conversation itself, straight from the AI SDK's `useChat`.
It restores context and is what gets submitted back to `/api/chat`.

**`toolEvents`** is the agent's activity log, projected from the `tool-invocation`
parts inside `messages`. It backs the debug panel, the inspector, the counters,
the agent status indicator and the timeline.

**`turnEvents`** marks where the conversation moved, so the timeline has no
unexplained gaps: a run that pauses for thirty seconds between two clicks should
show the answer that happened in between, not a hole. A user message always
produces one; an assistant message produces one only if it actually spoke, since
a message that merely made tool calls is already described by those.

**`lifecycleEvents`** covers app/runtime facts the AI SDK never records:
`session_created`, `sandbox_created`, `sandbox_reconnected`, `sandbox_killed`,
`sandbox_error`, `chat_error`.

`chat_error` is the one that is not about the sandbox: a request that never
reached a tool call — a routing failure at the relay, an unroutable model id — 
produces no message and no tool event, so without it a failed turn leaves no
trace anywhere in the UI. It carries the cause in `detail`.

The dividing question: **does this data need to participate verbatim in the next
LLM turn?** If yes it belongs in `messages`; if it only exists to be observed,
debugged or counted, it is an event.

**The line is content, not existence.** A `TurnEvent` records *that* a turn
happened, whose it was, and where it sits in the order — never a word of what was
said. `messages` therefore stays the sole owner of everything the next LLM turn
replays, which is what makes the event store safe to clear, filter or reshape.

Deliberately *not* done: folding message content into a flat event store, so that
events become the thing chat resume reads back. That works right up until the
first size-driven trim, and then trimming screenshots, reshaping events or
clearing debug data all become ways to break resume.

`session_switched` stays out of `Session.lifecycleEvents`. Every other lifecycle
event is a fact *about one session*, but switching is a cross-session action:
recording "A → B" under either side is arbitrary, and recording it under both
duplicates it. Sessions log only `session_created` and `sandbox_*`; app-level
actions belong in an app-level log, or nowhere.

## Event shape

`AgentEvent` is a discriminated union of three families:

- **`ToolEvent`** — a tool call / VM action. Satisfies the requirement to capture
  every tool call with id, timestamp, type, payload, status and duration.
- **`TurnEvent`** — a conversational turn. Carries a role and a position, no text.
- **`LifecycleEvent`** — session and sandbox lifecycle.

`computer` and `bash` are both tool calls but get distinct event types, because
their payloads have different shapes:

- `computer` — screenshot/click/type/scroll/key; may carry `coordinate`, `text`,
  or an image result.
- `bash` — command and stdout.

A union beats one wide type full of optional fields: the compiler then guarantees
field presence per variant instead of leaving every consumer to null-check.

## Identity

```text
sessionId   app session — create / switch / delete, and the localStorage key
messageId   AI SDK message id — locates which assistant message owns a tool call
toolCallId  AI SDK tool invocation id — used directly as ToolEvent.id
sandboxId   Vercel Sandbox VM id — reuse / kill / VNC reconnect
```

No separate `eventId` is minted: `ToolEvent.id = toolCallId`, and
`LifecycleEvent.id = crypto.randomUUID()`.

**Selection state must be session-scoped.** A bare `toolCallId` in
`selectedEventId` can point at an event in a different session after a switch.
Either clear the selection on switch, or key it as `${sessionId}:${toolCallId}`.

**Chat identity binds to `sessionId`, never `sandboxId`.** The upstream code uses
`useChat({ id: sandboxId })`, but the two have very different lifetimes: a sandbox
lives at most 45 minutes and the Hobby plan allows 10 concurrent. Returning to an
hour-old session finds a dead sandbox and has to create a new one — `sandboxId`
changes, `useChat`'s `id` changes with it, and the AI SDK treats it as a different
conversation and drops the state. So `Session.sandboxId` is not identity; it is a
mutable *current binding* that may be `null`, may be a dead id, and may be
replaced on reconnect.

## Ordering is observation order, not time

Every event carries an `order`, and the timeline sorts on that rather than on
`timestamp`. Tool timing is stamped by the server and lifecycle timing by the
browser; those two clocks need not agree, so a timestamp sort can interleave them
wrongly.

Each message owns a block of 1000 slots:

```text
message n, slot 0        the turn marker
message n, slot 1+p      the tool call at part index p
lifecycle at n messages  n * 1000 - 1, just ahead of message n's block
```

Ties keep insertion order, since `Array.prototype.sort` is stable — that is what
puts a lifecycle event before the message it precedes.

## Projection, not duplication

`ToolEvent[]` is never stored. It is derived from `messages`, because storing a
second copy of the same facts is a standing invitation to desynchronise. What is
actually persisted is `messages`, `lifecycleEvents`, `sandboxId`, `title` and
timestamps.

The projection keys on `toolCallId`: `state: "call"` projects to a pending event,
and the same `toolCallId` at `state: "result"` projects to complete or error.

AI SDK v4 tool invocations have **three** states — `partial-call`, `call`,
`result`. During `partial-call` the arguments are still accumulating and may be
half-parsed JSON. The projection either skips that state or marks it streaming
without rendering a payload; it must never present partial arguments as a payload,
or the debug panel flickers through fragments like `{"action":"left_cl`.

## Timing comes from the server

`durationMs` is **not** the client-observed gap between `call` and `result` — that
interval includes model latency and network round-trip, which would report a
200 ms screenshot as four seconds.

The server wraps `execute` with a timer and puts `durationMs`, `startedAt` and
`completedAt` into the tool result payload. Because that metadata rides along
inside the message, it survives a page reload and a restored session; client-side
timing does not.

Pending events have no start time yet, since `startedAt` only arrives with the
result. During that window the client stamps a *provisional* start purely to drive
the spinner and the elapsed counter; the moment the result lands, server metadata
overwrites it wholesale. Only server timing is ever recorded.

Carrying that metadata in the result object does **not** leak it into the model's
context — provided `experimental_toToolResultContent` keeps converting only the
image/text/stdout the model actually needs, and never degenerates into
`JSON.stringify(result)`. That is an implicit invariant, so it is pinned with a
comment on the function.

## Errors are values, not throws

`computerTool.execute` must not throw into the stream. A thrown error in AI SDK v4
does not produce an error-state tool result — it aborts the whole stream via
`onError`, so an error event would never reach the UI at all.

Instead it returns `{ ok: false, error, durationMs }`. The UI gets a real error
event, and the model gets the failure as feedback and can correct itself on the
next step rather than the run dying.

## Persistence

Screenshot base64 must never reach persistent storage. `localStorage` allows a few
megabytes; a single 1024x768 PNG is hundreds of kilobytes, and a thirty-step run
is tens of megabytes. Before persisting, `messages` are sanitised: keep
`toolCallId`, duration/error and screenshot metadata, drop the raw base64, and hold
at most the last N thumbnails in memory.

**Sanitising replaces content but preserves protocol structure.** It must not drop
the screenshot part or the `result` field — Anthropic requires every `tool_use` to
have a matching `tool_result`, and a missing one is a 400. The existing
`prunedMessages` already establishes the pattern:

```text
result: { type: "image", data: <base64> }
  →     { type: "text",  text: "Image redacted (persisted session)" }
```

`toolCallId`, the part and the `result` field all survive.

### Two prunings, doing different jobs

| Pruning | Where | Purpose | Effect |
|---|---|---|---|
| `prunedMessages` | server, per request | save input tokens | affects that one request only; client state untouched — lossless |
| persist sanitise | client, on write to localStorage | stay under the storage quota | **permanent**; the restored messages *are* this copy — lossy |

Only `messages` and `sandboxId` are ever sent to `/api/chat`; `lifecycleEvents`,
`sessionId` and `title` never leave the browser. But `messages` is a field *of* the
session — the copy trimmed to fit the storage quota is the copy that gets submitted
after a restore. Breaking it fails silently at write time and surfaces much later
as a 400, the first time the user returns to an old session and sends a message.
Hence the structural requirement above.

Before persistence exists this conflict cannot occur: `messages` lives only in
memory, the server prunes once per request, and the client copy stays intact.

## Keeping the desktop out of the render path

`DesktopPanel` subscribes to nothing. It takes stable props — `streamUrl`,
`sandboxId`, `onRefresh` — and no store.

`React.memo` alone is not enough. Memoisation is defeated by context: if the panel
sits anywhere below a provider whose value changes on every streamed token, it
re-renders regardless. So the chat/event provider lives inside the
`ChatWorkspace` subtree, which keeps that state off the desktop's ancestor chain
entirely. That placement is the mechanism, not a stylistic preference — it is the
invariant a later refactor is most likely to break.
