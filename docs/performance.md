# Performance

Two questions that keep getting asked with the wrong answer already in mind:
why the app is slow to show a restored conversation, and what happens when a
list gets long. Both are answered here with measurements rather than instinct,
including the parts that are deliberately left unoptimised.

The headline finding is the second section: a resumed transcript stayed blank
for the entire sandbox boot, and the cause was neither hydration nor storage nor
anything else on the chart below. It is fixed, and confirmed fixed in the
browser — messages now appear while "Initializing desktop…" is still spinning.

Last updated: 2026-08-09.

## Why a restored session takes a moment to appear

The obvious explanation is wrong. Reading a session back is **not** the cost:
`JSON.parse` of a stored body measures 0.04 ms at 20 messages and 0.36 ms at
200. Nor is anything fetched — the whole chain is local until the sandbox, at
the very end.

```text
SSR renders an empty shell        the server cannot read localStorage
  └─ download + parse ~426 kB JS  ← the long one
       └─ hydrate
            └─ bootstrap effect   readIndex / readSessionBody · 0.04–0.36 ms
                 └─ setActiveSessionId
                      └─ restore effect on that id
                           ├─ setMessages          ← the transcript appears here
                           └─ connectDesktop(...)  ← the only server round trip:
                                                     boots or reattaches a VM,
                                                     seconds, and gates the
                                                     composer via isInitializing
```

Two distinct waits come out of that, and they get confused for each other:

- **The transcript cannot appear before hydration.** No session id has to
  come from anywhere; it is derived locally the instant JS runs. First-load JS
  is dominated by `shiki` and `katex`, pulled in by `Streamdown` —
  lazy-loading that component is where an attack on this would start.
- **The composer is late because of a real request.** `connectDesktop` has
  exactly one call site on the load path (`app/page.tsx`, in the restore
  effect), so the VM cannot start booting until everything above it has
  finished. That serialisation is inherent rather than an oversight: the stored
  `sandboxId` is the hint that lets a session reattach instead of burning a
  fresh VM, and that hint only exists after hydration.

`isRestoring` in `lib/use-sessions.ts` covers the windows before `setMessages`
with a skeleton, so the app stops rendering an empty conversation it has no
grounds to claim. It does not make any of them shorter.

### The six-second gap the chart above does not explain

Hydration is a floor, not the whole wait. What it could not account for is the
symptom that actually got reported: on a resumed session the **event log is
populated while the transcript is still blank**, and the transcript fills in at
the exact moment "Initializing desktop…" disappears. Nothing in the transcript
reads `isInitializing`, and the two panels are siblings, so that correlation had
no business existing.

It came from `Streamdown`, whose default `mode="streaming"` works like this:

```js
const [isPending, startTransition] = useTransition();
const [blocks, setBlocks] = useState([]);            // seeded empty
const parsed = useMemo(() => parseMarkdownIntoBlocks(children), [children]);
useEffect(() => {
  mode === "streaming"
    ? startTransition(() => setBlocks(parsed))       // low priority
    : setBlocks(parsed);
}, [parsed, mode]);
const rendered = mode === "streaming" ? blocks : parsed;
```

Every `<Streamdown>` therefore renders **empty on its first commit** and fills
in from a transition. While a turn is streaming that is the whole point: parsing
markdown per token stays off the critical path. Restoring a transcript mounts a
dozen of them at once, and every one of them starts empty.

What holds them empty is `connectDesktop`. `getDesktopURL` is a Server Action,
which Next dispatches inside `startTransition`, and that transition stays pending
for as long as the VM takes to boot. React entangles transition lanes: Streamdown's
`setBlocks` lands behind the router's pending transition and cannot commit until
it resolves. The measured result is a transcript of correctly-sized, completely
empty message frames — 96 px of padding for four messages — that becomes 264 px
of text 5761 ms later, when the sandbox call returns.

The fix is `mode="static"` for any message that is not the one currently being
written (`components/message.tsx`). That path parses during render, so settled
messages paint with their text on the first commit; only the live message keeps
the streaming path, which is the only place its cost buys anything. Confirmed in
the browser: a resumed transcript now appears while the desktop is still
connecting. `PreviewMessage`'s memo comparator had to start comparing
`isLatestMessage` as well, or the previous message would stay stuck in streaming
mode after the next one started.

Two things follow from this that are worth keeping in mind elsewhere:

- **A pending Server Action delays every transition in the app,** not just the
  UI waiting on it. Anything that defers work with `startTransition` — a
  library's internals included — is stalled for the duration. `connectDesktop`
  is the long one here at several seconds.
- **Streaming-oriented components are usually wrong for history.** Their
  first-commit-empty behaviour is a deliberate trade for live text, and a
  restored transcript pays the cost for a benefit it cannot use.

The three explanations this replaced were all wrong, and each was wrong in an
instructive way, so: it was not hydration (the transcript and the event log are
written in one effect body, so hydration cannot separate them); it was not
motion's `initial={{ opacity: 0 }}` (disabling the mount animation changed
nothing); and it was not a lost SWR notification from `setMessages` (a
per-render log showed `messages: 4` with the right ids throughout the blank
window). Each was plausible from reading the code, and each died to one
measurement.

The measurement that found it samples the DOM every frame during the gap rather
than inspecting state:

```js
// inside the restore effect, temporarily
const t0 = performance.now();
let previous = "";
const tick = () => {
  const nodes = [...document.querySelectorAll("[data-role]")]
    .filter((n) => n.offsetParent !== null);   // both layouts are mounted
  const total = nodes.reduce((sum, n) => sum + n.getBoundingClientRect().height, 0);
  const state = `${nodes.length}/${Math.round(total)}`;
  if (state !== previous) {
    previous = state;
    console.log("[paint]", `+${Math.round(performance.now() - t0)}ms`,
                "nodes:", nodes.length, "height:", Math.round(total));
  }
  if (performance.now() - t0 < 15000) requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
```

Nodes present with the right count but far too little height is the signature of
a child that renders empty on first commit. Nodes present at `opacity: 0` would
have been an animation that never got a frame. No nodes at all, with the skeleton
still up, would have been a restore that had not run. Three different bugs, told
apart by two numbers.

## Long lists: what is optimised and what deliberately is not

There is memoisation but no virtualisation, and that is a decision rather than
an omission — the ceilings below all sit far above what this app can reach.

- **Transcript.** `PreviewMessage` is memoised on a deep compare of `parts`.
  Only the streaming message actually compares deeply: every older message keeps
  the same `parts` reference between renders, so `fast-deep-equal` returns at
  its first identity check.
- **Event log.** Unvirtualised, but the panel renders `null` while collapsed,
  which is its default state.
- **Session list.** Metadata only, and bounded by the storage quota that evicts
  bodies long before the index gets long.
- **The one real hot path** is the projection: every streamed token re-derives
  the whole event list from every message and re-sorts it, at `O(n log n)` per
  token (`app/page.tsx`, the `useMemo` block). Fine for hundreds of events;
  thousands would start dropping frames.

If a transcript ever does get long enough to matter, the order is: make the
projection incremental (cursor on message count, project only what is new), then
virtualise the event log. A session cannot currently hold enough turns to
justify either — localStorage evicts the body first.

## Reproducing the parse measurement

```bash
node -e '
const mk = (i) => ({
  id: "m" + i,
  role: i % 2 ? "assistant" : "user",
  content: "",
  parts: [
    { type: "text", text: "some model prose ".repeat(30) },
    { type: "tool-invocation", toolInvocation: { toolCallId: "t" + i,
      toolName: "computer", state: "result",
      args: { action: "left_click", coordinate: [100, 200] },
      result: { ok: true, durationMs: 412,
        data: { type: "text", text: "Image redacted (persisted session)" } } } },
  ],
});
for (const n of [20, 60, 200]) {
  const s = JSON.stringify({ messages: Array.from({ length: n }, (_, i) => mk(i)) });
  const t = performance.now();
  for (let k = 0; k < 20; k++) JSON.parse(s);
  console.log(n, "messages", (s.length / 1024).toFixed(0), "KB",
              ((performance.now() - t) / 20).toFixed(2), "ms");
}'
```
