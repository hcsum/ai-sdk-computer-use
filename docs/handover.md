# Handover

Where the dashboard stands, what is deliberately not built yet, and the things
that will waste an hour if nobody writes them down. Read
[`event-model.md`](./event-model.md) first — it is the spec this implementation
answers to, and it was written before any of the pipeline existed.

Last updated: 2026-08-09.

## State

`main` carries everything through PR #4. Nothing in flight; the working tree is
clean.

```text
#1  feat: portable model access and a relay-safe tool layer
#2  docs: event model spec for the agent pipeline
#3  feat: typed agent event pipeline with a live timeline panel
#4  feat: turn the event timeline into an inspectable dashboard
```

Verified on `main`: `pnpm test` (51 passed), `pnpm exec tsc --noEmit`,
`pnpm lint`, `pnpm build`, plus a manual run against a live sandbox. The
intermediate commits were not each built.

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

components/message.tsx           transcript      narrative, inline in the chat
components/agent-event-panel.tsx debug panel     aggregates + the flat log
components/event-inspector.tsx   inspector       one event's raw payload
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
| **Multiple sessions: create, switch, delete** | **not started** |
| **Persist to localStorage** | **not started** |
| Mobile-responsive (bonus) | partial — below `xl` the desktop panel is dropped and the app runs headless |
| Light / dark / system theme | done, `components/theme-toggle.tsx` |
| README, deployment, demo video | **not done** — see Next |

## Next

In order. The first item is the only remaining hard requirement in the brief;
the rest are deliverables, and the video cannot be recorded before sessions
exist because it has to show a session switch.

1. **Sessions** — the `Session` aggregate, a sidebar to create / switch /
   delete, and localStorage persistence. One milestone, one PR. The trap is
   below; read it before writing the serialiser.
2. **README** — the Features section is still the upstream demo's. It has to
   describe *this* app: the two-panel dashboard, the event pipeline, the
   inspector, sessions. Add a screenshot. This is the reviewer's first stop and
   the whole of the Documentation score, so it should read in 60 seconds, not
   be another essay.
3. **Deploy** to Vercel and put the URL in the README. Needs `ANTHROPIC_*`,
   `SANDBOX_SNAPSHOT_ID` and the Vercel Sandbox credentials set as project env
   vars — the OIDC token that works locally is not what production uses.
4. **Demo video**, 5 minutes with sound: layout and resizing, the debug panel,
   "What's the weather in Dubai?" end to end, a session switch, then the code
   tour — the projection, the discriminated union, the `DesktopPanel` memo.
5. **Invite** `lingjiekong`, `ghamry03`, `goldmermaid`, `EnergentAI` to the
   repository.

Not required and not worth starting: splitting `app/page.tsx` into containers,
testing the memo invariant, a desktop view below `xl`.

## The trap inside sessions

Persistence activates a failure that cannot happen today.

`event-model.md` requires that sanitising messages for storage **replaces content
but preserves protocol structure**. Anthropic rejects any `tool_use` without a
matching `tool_result` with a 400. Dropping a screenshot part, or its `result`
field, to save quota therefore breaks the conversation — and it breaks it
silently at write time, surfacing much later as a 400 the first time someone
returns to an old session and sends a message. `prunedMessages` in `lib/utils.ts`
already establishes the correct pattern: swap the image payload for text, keep
the envelope, the part and the `toolCallId`. That exact bug was already fixed
once, in commit `9045093`.

Two smaller rules from the spec that currently have no object and will need one:

- `selectedEventId` must be session-scoped, or cleared on switch. A bare
  `toolCallId` can name an event in a different session after a switch.
- `session_switched` is not a session lifecycle event. Recording a cross-session
  action under either side is arbitrary; it belongs in an app-level log or
  nowhere.

Also open, smaller: the `Session` aggregate itself (title, timestamps) does not
exist — `sessionId` is generated once on mount in `app/page.tsx`.

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
- **`app/page.tsx` is not yet split into `ChatWorkspace` / `DesktopPanel`
  containers.** `DesktopPanel` is extracted and memoised, which establishes the
  invariant; the provider-placement argument in `event-model.md` only becomes
  load-bearing once chat state moves into a context, which it has not.

## Upstream baseline

`ed103da` is the last upstream commit. `git diff ed103da..HEAD -- app components`
shows everything this fork changed in the UI.
