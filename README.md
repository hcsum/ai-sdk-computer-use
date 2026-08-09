Author: Haochen Xu

# AI Agent Dashboard

A computer-use AI agent that drives a real Linux desktop in a Vercel Sandbox, built on
[`vercel-labs/ai-sdk-computer-use`](https://github.com/vercel-labs/ai-sdk-computer-use).

- [Features](#features)
- [How It Works](#how-it-works)
- [Model Access & Tool Modes](#model-access--tool-modes)
- [Running Locally](#running-locally)
- [Environment Variables](#environment-variables)

## Features

- Streaming text responses powered by the [AI SDK](https://sdk.vercel.ai/docs).
- Claude with [computer use](https://sdk.vercel.ai/docs/guides/computer-use) and bash tool capabilities.
- Remote desktop environment running in a [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) with Chrome, a window manager, and VNC streaming.
- Provider, model and tool-declaration strategy are all configuration, so the agent runs
  against the official Anthropic API or an Anthropic-compatible relay without code changes.
- [shadcn/ui](https://ui.shadcn.com/) components for a modern, responsive UI powered by [Tailwind CSS](https://tailwindcss.com).
- Built with the latest [Next.js](https://nextjs.org) App Router.

## How It Works

The app spins up a Vercel Sandbox from a pre-built snapshot that includes:

- **Xvnc** — a virtual X11 display server
- **openbox** — a lightweight window manager
- **noVNC + websockify** — streams the desktop to the browser via WebSocket
- **Google Chrome** — auto-launched so the AI agent has a browser ready
- **xdotool + ImageMagick** — for mouse/keyboard control and screenshots

When a user sends a message, Claude uses the `computer` tool (screenshot, click, type, scroll) and the `bash` tool (run shell commands) to interact with the sandbox desktop. The noVNC stream is displayed in a resizable iframe alongside the chat.

### Architecture

```
User ↔ Next.js Chat UI ↔ AI SDK ↔ Claude (via lib/ai/provider.ts)
                                        ↓
                                  Vercel Sandbox
                              ┌─────────────────────┐
                              │  Xvnc (:99)         │
                              │  openbox             │
                              │  Chrome              │
                              │  websockify → noVNC  │
                              └─────────────────────┘
                                        ↓
                              noVNC iframe in browser
```

## Model Access & Tool Modes

The upstream demo hardcodes `api.anthropic.com` and a specific model id, and relies on
Anthropic's *provider-defined* `computer_20250124` / `bash_20250124` tools. Two changes
make that portable.

**The provider is constructed, not imported.** `@ai-sdk/anthropic`'s default `anthropic`
export resolves its base URL at module load and never reads `ANTHROPIC_BASE_URL`, so
`lib/ai/provider.ts` builds the provider explicitly from `ANTHROPIC_API_KEY`,
`ANTHROPIC_BASE_URL` and `ANTHROPIC_MODEL`. The base URL must include `/v1` — the SDK
requests `${baseURL}/messages` and never appends the version segment itself.

**The computer and bash tools are declared two ways**, selected by `COMPUTER_TOOL_MODE`:

| Mode | Declaration | Use when |
|---|---|---|
| `native` | `anthropicProvider.tools.computer_20250124(…)` | Running against the official API. The model is trained on this tool, so click accuracy is best. |
| `schema` (default) | `tool({ description, parameters: z.object(…), execute })` | Running against a relay. Provider-defined tools carry no `input_schema`; proxies that normalise the tool list drop them, and the model then emits `computer` calls with an empty `{}` input. |

Both branches share one `executeComputerAction(sandboxId)` closure, so the `xdotool`
implementation exists once and the two paths cannot drift. Under `schema` mode the tool
description has to supply what the trained tool would have implied — the coordinate
contract (1024x768, origin top-left) and the observe-then-act loop.

The full diagnosis, including the `curl` probes that isolated the relay's behaviour, is in
[`docs/model-access-notes.md`](docs/model-access-notes.md).

## Running Locally

### Prerequisites

- Node.js 18+
- A [Vercel](https://vercel.com) account (for Sandbox access)
- An [Anthropic API key](https://console.anthropic.com/)

### 1. Install dependencies

```bash
pnpm install
```

### 2. Set up Vercel credentials

Install the [Vercel CLI](https://vercel.com/docs/cli) and link your project:

```bash
pnpm install -g vercel
vercel link
vercel env pull
```

This creates a `.env.local` file with `VERCEL_OIDC_TOKEN` for Sandbox authentication.

Alternatively, set `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID` manually in your `.env.local`.

### 3. Create a sandbox snapshot

The snapshot pre-installs the desktop environment (Xvnc, Chrome, openbox, noVNC, xdotool, ImageMagick) so sandboxes boot in seconds.

```bash
npx tsx lib/sandbox/create-snapshot.ts
```

This takes ~10 minutes. When done, it outputs a snapshot ID. Add it to your `.env.local`:

```
SANDBOX_SNAPSHOT_ID=snap_xxxxxxxxxxxxx
```

### 4. Configure model access

Copy `.env.example` for the full list. At minimum:

```
ANTHROPIC_API_KEY=sk-ant-...
```

To run against an Anthropic-compatible relay instead, add:

```
ANTHROPIC_BASE_URL=https://your-relay.example/v1
ANTHROPIC_MODEL=claude-sonnet-5
COMPUTER_TOOL_MODE=schema
```

### 5. Start the dev server

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) to use the computer use agent.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude |
| `SANDBOX_SNAPSHOT_ID` | Yes | Vercel Sandbox snapshot with the desktop environment |
| `ANTHROPIC_BASE_URL` | No | Anthropic-compatible endpoint, **including `/v1`**. Defaults to the official API |
| `ANTHROPIC_MODEL` | No | Model id. Defaults to `claude-sonnet-5` |
| `COMPUTER_TOOL_MODE` | No | `schema` (default) or `native` — see [Model Access & Tool Modes](#model-access--tool-modes) |
| `VERCEL_OIDC_TOKEN` | Yes* | Auto-set by `vercel env pull` for Sandbox auth |
| `VERCEL_TOKEN` | Alt* | Alternative to OIDC — a Vercel personal access token |
| `VERCEL_TEAM_ID` | Alt* | Required with `VERCEL_TOKEN` |
| `VERCEL_PROJECT_ID` | Alt* | Required with `VERCEL_TOKEN` |

\* Either `VERCEL_OIDC_TOKEN` (via `vercel env pull`) or the `VERCEL_TOKEN` + team/project IDs are required for Sandbox authentication.

## Known upstream limitation

When running against a shared relay (`ANTHROPIC_BASE_URL`), the gateway
intermittently answers with a 503 whose body reads `无可用渠道 / no available
channel`: it has no upstream slot for the requested model at that instant. This
originates in the relay's routing pool, not in this app — the same request
succeeds seconds later with no change on this side.

What the app does about it:

- The request is retried five times with exponential backoff before anything
  reaches the UI, which absorbs most occurrences.
- If they all fail, the toast says the provider is busy and offers **Retry**,
  which replays the pending user turn.
- The gateway's verbatim response is recorded as a `chat_error` lifecycle event,
  visible in the event log and its inspector.

Retrying is the only remedy. Pointing `ANTHROPIC_BASE_URL` at the official
Anthropic API (or removing it) avoids the relay entirely.
