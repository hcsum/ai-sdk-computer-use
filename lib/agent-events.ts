import type { Message } from "ai";

import { ABORTED } from "./utils";

/**
 * `aborted` is its own status rather than a flavour of `error`: the user
 * pressing stop is the system doing what it was told, and folding it into
 * `error` turns a deliberate act into a red status dot and a phantom entry in
 * the failure count. The cause still travels in `error` so the row can say
 * *why* it stopped.
 */
export type ToolEventStatus = "pending" | "complete" | "aborted" | "error";

type ToolEventCommon = {
  kind: "tool";
  id: string;
  messageId: string;
  /**
   * Sort key, in the client's observation order. Each message owns a block of
   * 1000 slots; slot 0 is reserved for the message's own turn marker, so a tool
   * call sits at `messageIndex * 1000 + partIndex + 1`.
   *
   * Never sort the timeline on timestamps: tool timing comes from the server and
   * lifecycle timing from the browser, and those two clocks need not agree.
   */
  order: number;
  timestamp: string;
  status: ToolEventStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
};

export type ComputerEvent = ToolEventCommon & {
  tool: "computer";
  action: string;
  coordinate?: number[];
  text?: string;
  /** Screenshots stay in `messages`; the event only records that one came back. */
  hasScreenshot?: boolean;
  output?: string;
};

export type BashEvent = ToolEventCommon & {
  tool: "bash";
  command: string;
  stdout?: string;
};

export type OtherToolEvent = ToolEventCommon & {
  tool: "other";
  toolName: string;
  payload: unknown;
};

export type ToolEvent = ComputerEvent | BashEvent | OtherToolEvent;

/**
 * A conversational turn, recorded so the timeline has no unexplained gaps: a
 * run that pauses for thirty seconds between two clicks should show the answer
 * that happened in between, not a hole.
 *
 * It carries **no message content** — only that a turn occurred, and whose. The
 * dividing line the event model draws is content, not existence: `messages`
 * stays the sole owner of anything the next LLM turn replays, so clearing or
 * reshaping events can never break chat resume.
 */
export type TurnEvent = {
  kind: "turn";
  /** The AI SDK message id; a message produces at most one turn event. */
  id: string;
  messageId: string;
  order: number;
  timestamp: string;
  role: "user" | "assistant";
};

export type LifecycleEvent = {
  kind: "lifecycle";
  id: string;
  order: number;
  timestamp: string;
  type:
    | "session_created"
    | "sandbox_created"
    | "sandbox_reconnected"
    | "sandbox_killed"
    | "sandbox_error"
    | "chat_error";
  label: string;
  /** Cause of a failure, when the type carries one. */
  detail?: string;
  sandboxId?: string | null;
};

export const isLifecycleFailure = (event: LifecycleEvent) =>
  event.type === "sandbox_error" || event.type === "chat_error";

export type AgentEvent = ToolEvent | TurnEvent | LifecycleEvent;

/** Events projected from `messages`, as opposed to recorded by the app. */
export type ProjectedEvent = ToolEvent | TurnEvent;

/**
 * Selection key. A `toolCallId` and a lifecycle UUID are drawn from different
 * spaces and could in principle collide, so the family is part of the key.
 *
 * Session scoping is the caller's job: a key held across a session switch can
 * name an event that no longer exists, so selection is cleared on switch.
 */
export const agentEventKey = (event: AgentEvent) => `${event.kind}-${event.id}`;

type ToolInvocationPart = {
  type: "tool-invocation";
  toolInvocation: {
    toolCallId: string;
    toolName: string;
    state: string;
    args?: unknown;
    result?: unknown;
  };
};

const isToolInvocationPart = (part: unknown): part is ToolInvocationPart => {
  if (!part || typeof part !== "object") return false;
  const candidate = part as Partial<ToolInvocationPart>;
  return candidate.type === "tool-invocation" && Boolean(candidate.toolInvocation);
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const asString = (value: unknown) => (typeof value === "string" ? value : undefined);

const resultLooksLikeError = (result: unknown) => {
  if (!result || typeof result !== "object") return false;
  const candidate = result as { ok?: unknown; error?: unknown };
  return candidate.ok === false || Boolean(candidate.error);
};

const settledStatus = (result: unknown): ToolEventStatus =>
  result === ABORTED ? "aborted" : resultLooksLikeError(result) ? "error" : "complete";

const getExecutionMeta = (result: unknown) => {
  if (result === ABORTED) return { error: ABORTED };
  const candidate = asRecord(result);
  return {
    startedAt: asString(candidate.startedAt),
    completedAt: asString(candidate.completedAt),
    durationMs: typeof candidate.durationMs === "number" ? candidate.durationMs : undefined,
    error: asString(candidate.error),
  };
};

/** Only reads the successful payload; errors carry their message in the meta. */
const getResultData = (result: unknown) => {
  const candidate = asRecord(result);
  if (candidate.ok !== true) return undefined;
  return candidate;
};

/**
 * The bytes behind `hasScreenshot`. Events stay light on purpose, so whatever
 * renders the image reads it back out of `messages` through here — this is the
 * only sanctioned way across that boundary.
 */
export const getScreenshotBase64 = (result: unknown): string | undefined => {
  const data = asRecord(getResultData(result)?.data);
  return data.type === "image" ? asString(data.data) : undefined;
};

/**
 * The raw invocation behind an event, for the inspector. Looked up on demand
 * rather than indexed: only the selected event ever needs it, and a result can
 * carry a megabyte of screenshot that nothing else should be holding onto.
 */
export const findToolPayload = (
  messages: Message[],
  toolCallId: string,
): { args: unknown; result: unknown } | undefined => {
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (!isToolInvocationPart(part)) continue;
      if (part.toolInvocation.toolCallId !== toolCallId) continue;
      return { args: part.toolInvocation.args, result: part.toolInvocation.result };
    }
  }
  return undefined;
};

const projectComputer = (args: unknown, result: unknown) => {
  const input = asRecord(args);
  const data = asRecord(getResultData(result)?.data);
  return {
    tool: "computer" as const,
    action: asString(input.action) ?? "unknown",
    coordinate: Array.isArray(input.coordinate)
      ? (input.coordinate as number[])
      : undefined,
    text: asString(input.text),
    hasScreenshot: data.type === "image" ? true : undefined,
    output: data.type === "text" ? asString(data.text) : undefined,
  };
};

const projectBash = (args: unknown, result: unknown) => ({
  tool: "bash" as const,
  command: asString(asRecord(args).command) ?? "",
  stdout: asString(getResultData(result)?.stdout),
});

/**
 * Projects `messages` into the tool-event log. Holds one piece of state: the
 * provisional start time of a call that has not returned yet. `startedAt` only
 * arrives with the result, so the spinner needs a stable client-side stamp until
 * then — server metadata overwrites it wholesale the moment it lands.
 */
export const createToolEventProjector = (now = () => new Date().toISOString()) => {
  const provisionalStarts = new Map<string, string>();

  return (messages: Message[]): ToolEvent[] => {
    const events = new Map<string, ToolEvent>();

    messages.forEach((message, messageIndex) => {
      message.parts?.forEach((part, partIndex) => {
        if (!isToolInvocationPart(part)) return;

        const { toolCallId, toolName, state, args, result } = part.toolInvocation;
        if (!toolCallId || state === "partial-call") return;

        const isResult = state === "result";
        const meta = getExecutionMeta(isResult ? result : undefined);

        let provisionalStart = provisionalStarts.get(toolCallId);
        if (!provisionalStart) {
          provisionalStart = now();
          provisionalStarts.set(toolCallId, provisionalStart);
        }

        const common: ToolEventCommon = {
          kind: "tool",
          id: toolCallId,
          messageId: message.id,
          order: messageIndex * 1000 + partIndex + 1,
          timestamp: meta.startedAt ?? provisionalStart,
          status: isResult ? settledStatus(result) : "pending",
          ...meta,
        };

        const projected =
          toolName === "computer"
            ? projectComputer(args, isResult ? result : undefined)
            : toolName === "bash"
              ? projectBash(args, isResult ? result : undefined)
              : { tool: "other" as const, toolName, payload: args };

        events.set(toolCallId, { ...common, ...projected });
      });
    });

    return [...events.values()].sort((a, b) => a.order - b.order);
  };
};

export const deriveToolEvents = (messages: Message[]): ToolEvent[] =>
  createToolEventProjector()(messages);

const getMessageText = (message: Message) => {
  const fromParts = message.parts
    ?.map((part) => (part.type === "text" ? part.text : ""))
    .join("");
  return (fromParts || message.content || "").trim();
};

/**
 * Projects `messages` into turn markers. An assistant message that only carried
 * tool calls produces none: its tool events already describe it, and a marker
 * there would be a second row saying the same thing. A user message always
 * produces one — it is the only record that the run was asked anything.
 *
 * Holds the same one piece of state the tool projector does: a provisional
 * timestamp for a message the AI SDK stamped no `createdAt` on.
 */
export const createTurnEventProjector = (now = () => new Date().toISOString()) => {
  const provisionalTimestamps = new Map<string, string>();

  return (messages: Message[]): TurnEvent[] => {
    const events: TurnEvent[] = [];

    messages.forEach((message, messageIndex) => {
      if (message.role !== "user" && message.role !== "assistant") return;
      if (message.role === "assistant" && !getMessageText(message)) return;

      let provisional = provisionalTimestamps.get(message.id);
      if (!provisional) {
        provisional = now();
        provisionalTimestamps.set(message.id, provisional);
      }

      events.push({
        kind: "turn",
        id: message.id,
        messageId: message.id,
        // Slot 0 of the message's block: ahead of every tool call it made.
        order: messageIndex * 1000,
        timestamp: message.createdAt?.toISOString() ?? provisional,
        role: message.role,
      });
    });

    return events;
  };
};

export const deriveTurnEvents = (messages: Message[]): TurnEvent[] =>
  createTurnEventProjector()(messages);

/**
 * Both families are keyed in the same observation-order space, so a plain sort
 * interleaves them. Equal keys keep insertion order — `Array.prototype.sort` is
 * stable — which is what puts a lifecycle event before the message it precedes.
 */
export const mergeAgentEvents = (
  lifecycleEvents: LifecycleEvent[],
  projectedEvents: ProjectedEvent[],
): AgentEvent[] => {
  return [...lifecycleEvents, ...projectedEvents].sort((a, b) => a.order - b.order);
};

/**
 * The order a lifecycle event observed *now* should occupy: after everything
 * belonging to the messages that already exist, and before the next message's
 * turn marker, which opens that message's block at slot 0.
 */
export const lifecycleOrderFor = (messageCount: number) => messageCount * 1000 - 1;
