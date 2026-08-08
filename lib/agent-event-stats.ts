import { isLifecycleFailure, type AgentEvent } from "./agent-events";

/**
 * Derived state. Everything here is a fold over the event list, held nowhere:
 * a counter kept as its own state is a counter that can disagree with the log
 * it claims to summarise.
 */

export type AgentStatus = "idle" | "thinking" | "acting" | "error";

export type ChatStatus = "error" | "submitted" | "streaming" | "ready";

export const isFailedEvent = (event: AgentEvent) =>
  event.kind === "lifecycle" ? isLifecycleFailure(event) : event.status === "error";

/**
 * `thinking` and `acting` are both "a turn is in flight", split by whether the
 * agent is waiting on the model or on the VM — which is the distinction a user
 * watching a stalled run actually wants.
 */
export const deriveAgentStatus = (
  events: AgentEvent[],
  chatStatus: ChatStatus,
): AgentStatus => {
  if (chatStatus === "error") return "error";

  const hasPendingTool = events.some(
    (event) => event.kind === "tool" && event.status === "pending",
  );
  if (hasPendingTool) return "acting";

  if (chatStatus === "submitted" || chatStatus === "streaming") return "thinking";

  // Only the most recent event decides: a failure the agent recovered from is
  // history, not the current state.
  const lastEvent = events.at(-1);
  if (lastEvent && isFailedEvent(lastEvent)) return "error";

  return "idle";
};

export type ActionCount = { action: string; count: number };

/**
 * Counts per action type, which for a computer call means the VM action rather
 * than the tool name — "left_click ×4" is the useful unit, "computer ×15" is not.
 */
export const countActions = (events: AgentEvent[]): ActionCount[] => {
  const counts = new Map<string, number>();

  for (const event of events) {
    if (event.kind !== "tool") continue;
    const action =
      event.tool === "computer"
        ? event.action
        : event.tool === "bash"
          ? "bash"
          : event.toolName;
    counts.set(action, (counts.get(action) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([action, count]) => ({ action, count }))
    .sort((a, b) => b.count - a.count || a.action.localeCompare(b.action));
};

export type EventSummary = {
  toolCalls: number;
  pending: number;
  failed: number;
  /** Server-measured VM time only — model latency is not in here. */
  totalDurationMs: number;
};

export const summarizeEvents = (events: AgentEvent[]): EventSummary => {
  let toolCalls = 0;
  let pending = 0;
  let failed = 0;
  let totalDurationMs = 0;

  for (const event of events) {
    if (isFailedEvent(event)) failed += 1;
    if (event.kind !== "tool") continue;
    toolCalls += 1;
    if (event.status === "pending") pending += 1;
    totalDurationMs += event.durationMs ?? 0;
  }

  return { toolCalls, pending, failed, totalDurationMs };
};

export const EVENT_FILTERS = ["all", "tools", "lifecycle", "errors"] as const;

export type EventFilter = (typeof EVENT_FILTERS)[number];

export const filterEvents = (events: AgentEvent[], filter: EventFilter): AgentEvent[] => {
  switch (filter) {
    case "tools":
      return events.filter((event) => event.kind === "tool");
    case "lifecycle":
      return events.filter((event) => event.kind === "lifecycle");
    case "errors":
      return events.filter(isFailedEvent);
    default:
      return events;
  }
};
