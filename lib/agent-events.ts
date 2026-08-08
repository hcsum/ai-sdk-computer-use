import type { Message } from "ai";

import { ABORTED } from "./utils";

export type ToolEventStatus = "pending" | "complete" | "error";

type ToolEventCommon = {
  kind: "tool";
  id: string;
  messageId: string;
  /**
   * Sort key, in the client's observation order (message index + part index).
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

export type AgentEvent = ToolEvent | LifecycleEvent;

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
  if (result === ABORTED) return true;
  if (!result || typeof result !== "object") return false;
  const candidate = result as { ok?: unknown; error?: unknown };
  return candidate.ok === false || Boolean(candidate.error);
};

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
          order: messageIndex * 1000 + partIndex,
          timestamp: meta.startedAt ?? provisionalStart,
          status: isResult
            ? resultLooksLikeError(result)
              ? "error"
              : "complete"
            : "pending",
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

/**
 * Both families are keyed in the same observation-order space, so a plain sort
 * interleaves them. Equal keys keep insertion order — `Array.prototype.sort` is
 * stable — which is what puts a lifecycle event before the message it precedes.
 */
export const mergeAgentEvents = (
  lifecycleEvents: LifecycleEvent[],
  toolEvents: ToolEvent[],
): AgentEvent[] => {
  return [...lifecycleEvents, ...toolEvents].sort((a, b) => a.order - b.order);
};

/**
 * The order a lifecycle event observed *now* should occupy: after every tool
 * event of the messages that already exist, before the next message's.
 */
export const lifecycleOrderFor = (messageCount: number) => messageCount * 1000 - 1;
