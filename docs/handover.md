# Handover

Where the dashboard stands, what is deliberately not built yet, and the things
that will waste an hour if nobody writes them down. Read
[`event-model.md`](./event-model.md) first — it is the spec this implementation
answers to, and it was written before any of the pipeline existed.
[`performance.md`](./performance.md) answers the two speed questions: why a
restored session takes a moment to paint, and what happens to a long list.

Last updated: 2026-08-09.

## State

`main` carries everything through PR #4. Sessions are on `feat/sessions`, four
commits, **not yet merged and not yet pushed** — opening that PR is the first
thing to do.

```text
#1  feat: portable model access and a relay-safe tool layer
#2  docs: event model spec for the agent pipeline
#3  feat: typed agent event pipeline with a live timeline panel
#4  feat: turn the event timeline into an inspectable dashboard
    feat/sessions ─ storage layer → useSessions → the rail → these docs
```

Verified on `feat/sessions`: `pnpm test` (64 passed), `pnpm exec tsc --noEmit`,
`pnpm lint`, `pnpm build`, plus a manual run against a live sandbox.

The two quiet paths have since been driven by hand, and both hold:

- **Switch mid-stream, switch back, send again.** The interrupted run stops, the
  session resumes and continues normally. That last send is the test — a
  dangling `tool_use` surfaces as a 400 on the *next* request, never at the
  moment of switching.
- **Reload, open an old session, keep talking.** The redacted transcript is
  still accepted, so `sanitiseMessagesForStorage` preserves enough protocol
  structure.

What that run did *not* prove: the sandbox was likely still alive, so
`getDesktop`'s reconnect-or-recreate branch may not have been exercised. Not a
protocol risk — the worst case is a long spin before a fresh VM. Confirm it by
killing the VM in Vercel, or by returning to a session the next day.

Merges are merge commits, not squashes, deliberately: the brief says the
incremental commits are reviewed, and squashing destroys exactly that.

## Shape of the thing

One projection, three views. `messages` is the only stored conversation state;
everything the dashboard shows is derived from it.

```text
lib/agent-events.ts        messages ──▶ ToolEvent[] + TurnEvent[]
                           app       ──▶ LifecycleEvent[]
                           merge, sorted on `order`

lib/agent-event-stats.ts   events ──▶ agent status, action counts, totals, filters
lib/tool-event-display.ts  event  ──▶ words and an icon, at two densities

lib/session-store.ts       localStorage: index + one key per session
lib/use-sessions.ts        create / switch / delete, debounced persistence

components/message.tsx            transcript      narrative, inline in the chat
components/agent-event-panel.tsx  debug panel     aggregates + the flat log
components/event-inspector.tsx    inspector       one event's raw payload
components/session-sidebar.tsx    session rail    rail on xl, drawer below it
```

Colours go through the semantic tokens in `app/globals.css`; `next-themes`
writes the class on `<html>` before paint. Nothing should reintroduce a literal
`bg-white` or a zinc scale — those cannot reach the `.dark` palette.

Three facts worth not rediscovering:

- **Sorting is on `order`, never on `timestamp`.** Tool timing comes from the
  server, lifecycle timing from the browser, and those clocks need not agree.
  Each message owns 1000 slots; slot 0 is its turn marker. See the Ordering
  section in `event-model.md`.
- **Screenshot base64 never enters an event.** `hasScreenshot` is the flag,
  `getScreenshotBase64(result)` is the only sanctioned way back to the bytes,
  and `findToolPayload(messages, id)` fetches a payload for the selected event
  alone.
- **`DesktopPanel` must stay off the chat state's ancestor chain.** `memo` is
  necessary but not sufficient — a context whose value changes per token defeats
  it, and the iframe remounting drops the VNC connection mid-run.
- **There is no in-memory map of sessions.** `useChat` owns the active
  transcript, keyed on `sessionId`; storage owns the rest. Switching is always
  flush-then-restore, so a switch and a reload take the same path — screenshot
  redaction included, which is why a session you come back to shows redacted
  placeholders where its screenshots were.
- **A restore has to land in an effect on `activeSessionId`, never in the switch
  handler.** `useChat` keys its state on that id, so a `setMessages` issued
  before the render that carries the new id writes the incoming transcript into
  the session being left.

## Against the brief

| Requirement | State |
|---|---|
| Two-panel layout, chat left / VNC right | done |
| Inline tool call visualisations | done |
| Collapsible debug panel | done, collapsed by default |
| Expanded tool call details in the right panel | done — the inspector |
| Horizontally resizable panels | done; the right column also splits vertically |
| Typed event pipeline, id/timestamp/type/payload/status/duration | done |
| Derived state: counts per action type, agent status | done, `agent-event-stats.ts` |
| Debug panel visualising the event store | done, with filters |
| No `any`, discriminated unions | done |
| VNC does not re-render on chat updates | done, `DesktopPanel` |
| Multiple sessions: create, switch, delete | done, `lib/use-sessions.ts` |
| Persist to localStorage | done, `lib/session-store.ts` |
| Mobile-responsive (bonus) | partial — below `xl` the desktop panel is dropped and the app runs headless |
| Light / dark / system theme | done, `components/theme-toggle.tsx` |
| README, deployment, demo video | **not done** — see Next |

## Next

Every hard requirement in the brief is now met; what is left is deliverables.

1. **README** — the Features section is still the upstream demo's. It has to
   describe *this* app: the two-panel dashboard, the event pipeline, the
   inspector, sessions. Add a screenshot. This is the reviewer's first stop and
   the whole of the Documentation score, so it should read in 60 seconds, not
   be another essay.
2. **Deploy** to Vercel and put the URL in the README. Needs `ANTHROPIC_*`,
   `SANDBOX_SNAPSHOT_ID` and the Vercel Sandbox credentials set as project env
   vars — the OIDC token that works locally is not what production uses.
3. **Demo video**, 5 minutes with sound: layout and resizing, the debug panel,
   "What's the weather in Dubai?" end to end, a session switch, then the code
   tour — the projection, the discriminated union, the `DesktopPanel` memo.
4. **Invite** `lingjiekong`, `ghamry03`, `goldmermaid`, `EnergentAI` to the
   repository.

Not required and not worth starting: splitting `app/page.tsx` into containers,
testing the memo invariant, a desktop view below `xl`.

## The trap inside sessions, and where it is handled

Persistence activates a failure that cannot happen without it, so the guard is
in one place: `sanitiseMessagesForStorage` in `lib/session-store.ts`.

`event-model.md` requires that sanitising messages for storage **replaces content
but preserves protocol structure**. Anthropic rejects any `tool_use` without a
matching `tool_result` with a 400. Dropping a screenshot part, or its `result`
field, to save quota therefore breaks the conversation — and it breaks it
silently at write time, surfacing much later as a 400 the first time someone
returns to an old session and sends a message. That exact bug was already fixed
once on the request path, in commit `9045093`.

So the sanitiser swaps only the image payload inside `data`, keeping the part,
the `toolCallId`, the `result` field and the `ok: true` envelope. It also closes
any call still at `state: "call"` with an aborted result: a session gets written
while a run may be in flight, and a dangling `tool_use` is the same 400 waiting
to happen. Both rules are covered by `lib/session-store.test.ts` — if you change
that function, those tests are the reason it is safe.

The two smaller rules from the spec now have objects:

- `selectedEventId` is cleared on switch, in the restore effect. A bare
  `toolCallId` can otherwise name an event in a different session.
- `session_switched` is not recorded anywhere. Recording a cross-session action
  under either side is arbitrary.

Still worth knowing:

- **Switching kills the outgoing sandbox.** The Hobby plan allows ten
  concurrent, and the outgoing session has already been flushed, so the kill
  cannot be recorded against it. Returning to that session reconnects if the VM
  happens to be alive and otherwise creates a fresh one — `getDesktop` decides,
  from the stored `sandboxId` being a hint rather than identity.
- **Quota eviction drops bodies, not index entries.** An evicted session still
  lists and still opens; it opens empty. Losing the row would look like data
  loss, and opening empty at least says what happened.
- **Sessions are not synced across tabs.** Two tabs each flush their own active
  session and last write wins on the index. Out of scope for the brief; a
  `storage` event listener is where it would start.

## Operational notes

- **`VERCEL_OIDC_TOKEN` expires roughly every twelve hours.** No sandbox will
  start once it does. Fix with `vercel env pull`.
- **The relay (packyapi) intermittently 503s** with `model_not_found` or
  `分组 cc-sale 下模型无可用渠道`. It is a routing failure, not an outage — switch
  model. Verified working with stream + tools: `claude-sonnet-5`,
  `claude-opus-5`, `claude-sonnet-4-6`, `claude-opus-4-8`,
  `claude-haiku-4-5-20251001`. Set `ANTHROPIC_MODEL` in `.env.local`.
  Probe it with:
  ```bash
  curl -s "$ANTHROPIC_BASE_URL/models" -H "Authorization: Bearer $ANTHROPIC_API_KEY"
  ```
- **`COMPUTER_TOOL_MODE` defaults to `schema`,** which the relay requires: it
  normalises the tool list and drops Anthropic's provider-defined
  `computer_20250124`, after which the model emits `computer` calls with an empty
  input. `native` is correct against the official API. See
  [`model-access-notes.md`](./model-access-notes.md).
- The upstream demo defaulted to `claude-sonnet-4-5-20250929`, which the relay
  cannot route. This fork defaults to `claude-sonnet-5`.

## Decisions taken, in case they look arbitrary

- **The debug panel is collapsed by default.** The transcript is the primary
  surface; this is instrumentation you open. Worth revisiting if reviewers open
  the deployed app and miss it.
- **Turn events carry no message content.** The line the event model draws is
  content, not existence — see the commit message on `fa5a7ae`.
- **Settled messages render with `Streamdown mode="static"`, only the streaming
  one uses `mode="streaming"`.** Not a micro-optimisation: the streaming mode
  renders empty on first commit and fills from a `startTransition`, which a
  pending Server Action can stall for seconds. See
  [`performance.md`](./performance.md).
- **`app/page.tsx` is not yet split into `ChatWorkspace` / `DesktopPanel`
  containers.** `DesktopPanel` is extracted and memoised, which establishes the
  invariant; the provider-placement argument in `event-model.md` only becomes
  load-bearing once chat state moves into a context, which it has not.

## Upstream baseline

`ed103da` is the last upstream commit. `git diff ed103da..HEAD -- app components`
shows everything this fork changed in the UI.
