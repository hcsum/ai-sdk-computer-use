# Model access notes

Working notes on getting the computer-use agent loop running against an
Anthropic-compatible relay instead of the official API. Kept as raw material for
the README's technical-decisions section.

## Context

The upstream demo assumes direct access to `api.anthropic.com`. Signing up there
requires a payment card we could not use, so the agent runs against **PackyAPI**,
an Anthropic-compatible relay. Everything below is what broke on the way, how it
was diagnosed, and what the code does about it.

## 1. The provider ignores `ANTHROPIC_BASE_URL`

`@ai-sdk/anthropic`'s default `anthropic` export resolves its base URL at module
load and never reads `ANTHROPIC_BASE_URL`:

```js
// node_modules/@ai-sdk/anthropic/dist/index.js
const baseURL = withoutTrailingSlash(options.baseURL) ?? "https://api.anthropic.com/v1";
```

Setting the env var has no effect — the only way to redirect it is an explicit
`createAnthropic({ baseURL })`.

**Fix:** `lib/ai/provider.ts` builds the provider from `ANTHROPIC_API_KEY` +
`ANTHROPIC_BASE_URL`, and exports a single `agentModel` that `app/api/chat/route.ts`
consumes.

Note the base URL must include `/v1`. The provider builds request URLs as
`${baseURL}/messages`, so it never appends the version segment itself — unlike
Claude Code, which takes a bare host.

## 2. The hardcoded model id does not exist on the relay

The demo pins `claude-sonnet-4-5-20250929`. The relay returned:

```
503 {"error":{"code":"model_not_found",
  "message":"分组 aws-q 下模型 claude-sonnet-4-5-20250929 无可用渠道（distributor）"}}
```

Model availability varies per relay *token group*, and the catalogue is
enumerable:

```bash
curl -s "$ANTHROPIC_BASE_URL/models" -H "Authorization: Bearer $ANTHROPIC_API_KEY"
```

**Fix:** the model id is now configuration (`ANTHROPIC_MODEL`, defaulting to
`claude-sonnet-5`) rather than a literal in the route handler.

## 3. The relay drops Anthropic's server-side tool types

This was the real blocker. The first agent turn failed server-side with:

```
ZodError: {
  expected: "'key' | 'hold_key' | 'type' | ... | 'screenshot'",
  received: "undefined",
  path: ["action"]
}
```

The model returned a `computer` tool call whose `input` was an empty object.

### Diagnosis

Anthropic's computer/bash/text-editor tools are *provider-defined*: they go over
the wire without an `input_schema`, because the model is trained to know their
argument shape.

```json
{ "type": "computer_20250124", "name": "computer",
  "display_width_px": 1024, "display_height_px": 768 }
```

A regular function tool carries its own schema:

```json
{ "name": "get_weather", "input_schema": { "type": "object", "properties": { … } } }
```

Probing the relay directly with `curl` separated the two cases:

| Request | Result |
| --- | --- |
| Custom tool with `input_schema` | `input: {"city":"Dubai"}` — correct |
| `computer_20250124`, non-streaming | `input: {}` — `action` missing |
| `computer_20250124`, streaming | `content_block_start` only, zero `input_json_delta` frames |
| Same, asked explicitly to click a coordinate | Model replies it has no GUI capability at all |

The last row is the decisive one: the model is not failing to *serialize* the
call, it never receives a usable tool definition. The relay's request translation
layer discards tool entries that carry no `input_schema`.

This reproduced across every model the relay exposes (`claude-sonnet-5`,
`claude-sonnet-4-6`, `claude-opus-4-5` … `claude-opus-5`, `claude-haiku-4-5`) and
across two unrelated upstreams (`aws-q` and `cc-sale`, both Bedrock-backed —
tool ids came back prefixed `toolu_bdrk_`). It also reproduced identically across
all three of the relay's ingress endpoints, so it is not a routing artifact.

### Fix: a schema-carrying fallback definition

`lib/sandbox/tool.ts` now declares the same tool two ways behind
`COMPUTER_TOOL_MODE`:

- `native` — `anthropicProvider.tools.computer_20250124(…)`, the trained
  provider-defined tool. Correct against the official API.
- `schema` (default) — a plain `tool({ description, parameters, execute })` whose
  Zod schema restates the action enum, `coordinate`, `text`, scroll and drag
  arguments. Survives the relay's translation layer.

Both branches share one `executeComputerAction(sandboxId)` closure, so the
`xdotool` / `import` implementation exists once and neither path can drift from
the other. `bashTool` follows the same pattern.

### What the fallback costs

Under `schema` mode the model is not routed through its trained computer-use
behaviour, so two things have to be supplied by hand in the tool description:

1. **The coordinate contract.** Origin, axis directions and screen bounds are
   spelled out explicitly, since the model can no longer assume them.
2. **The observe-then-act loop.** The native tool implies "screenshot, then act";
   the description now states it, including "never guess coordinates from memory
   — locate the target in the most recent screenshot."

Expect somewhat lower click accuracy than the native tool. Keeping the display at
1024x768 helps: it matches the resolution the screenshots are captured at, so no
rescaling sits between what the model sees and where the cursor lands.

## Current configuration

```
ANTHROPIC_BASE_URL   relay endpoint, including /v1
ANTHROPIC_MODEL      defaults to claude-sonnet-5
COMPUTER_TOOL_MODE   schema (default) | native
SANDBOX_SNAPSHOT_ID  Vercel Sandbox snapshot with the desktop image
```

Set `COMPUTER_TOOL_MODE=native` and point `ANTHROPIC_BASE_URL` at
`https://api.anthropic.com/v1` to run against the official API unchanged.

## Relay-specific gotchas

Two operational notes, relevant only when running against PackyAPI.

**Token groups gate third-party access.** Groups intended for the Claude Code CLI
reject SDK traffic outright:

```
{"error":{"message":"This API endpoint is only accessible via the official Claude CLI"}}
```

Only groups documented as supporting third-party integrations work here. Four
were tested:

| Group | SDK traffic | `computer_20250124` | Notes |
| --- | --- | --- | --- |
| `aws-q` | accepted | `input: {}` | Cheapest tier; Bedrock-backed |
| `cc-sale` | accepted | `input: {}` | Bedrock-backed (`toolu_bdrk_` tool ids) — **in use** |
| `cc` | rejected, CLI-only | untestable | Docs warn that third-party traffic can get the account suspended |
| `claude-sale` | rejected, CLI-only | untestable | Documented as Claude Code only |

The two groups that accept SDK traffic fail the server-side tool identically
despite sitting on different upstreams, which is what points at the relay's own
translation layer rather than any one backend.

**Identifying the active group.** The group name is not exposed by any endpoint,
but it appears in the error body when a model is unavailable — so requesting a
nonexistent model reveals it without touching an upstream:

```bash
curl -s "$ANTHROPIC_BASE_URL/messages" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"zzz","max_tokens":8,"messages":[{"role":"user","content":"x"}]}'
```

## Infrastructure

The desktop is a Vercel Sandbox built from a snapshot (`create-snapshot.ts`:
TigerVNC, openbox, Chrome, noVNC + websockify, xdotool, ImageMagick). Snapshot
builds take roughly ten minutes.

Hobby-plan allowances are far above what this project needs — 5 Active-CPU
hours, 420 GB-hours of memory, 5,000 creations and 20 GB egress per month, 15 GB
of lifetime snapshot storage, 45 minutes maximum per sandbox, 10 concurrent.
Time spent waiting on model responses does not count toward Active CPU. The one
figure worth watching is snapshot storage, since it is a lifetime rather than
monthly allowance — avoid rebuilding the snapshot repeatedly.

`VERCEL_OIDC_TOKEN` from `vercel env pull` expires after 12 hours; re-pull when
sandbox creation starts failing to authenticate.
