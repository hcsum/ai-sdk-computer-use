import { describe, expect, it } from "vitest";

import type { AgentEvent, LifecycleEvent, ToolEvent } from "./agent-events";
import {
  countActions,
  deriveAgentStatus,
  filterEvents,
  isFailedEvent,
  summarizeEvents,
} from "./agent-event-stats";

const toolBase = {
  kind: "tool",
  messageId: "message-1",
  order: 0,
  timestamp: "2026-01-01T00:00:00.000Z",
} as const;

const computer = (
  id: string,
  action: string,
  overrides: Partial<ToolEvent> = {},
): ToolEvent =>
  ({
    ...toolBase,
    id,
    tool: "computer",
    action,
    status: "complete",
    ...overrides,
  }) as ToolEvent;

const lifecycle = (
  id: string,
  type: LifecycleEvent["type"],
  detail?: string,
): LifecycleEvent => ({
  kind: "lifecycle",
  id,
  order: -1,
  timestamp: "2026-01-01T00:00:00.000Z",
  type,
  label: type,
  detail,
});

describe("an aborted call is an outcome, not a failure", () => {
  const aborted = computer("a", "screenshot", {
    status: "aborted",
    error: "User aborted",
  });

  it("is not a failed event", () => {
    expect(isFailedEvent(aborted)).toBe(false);
  });

  it("does not leave the agent in an error state", () => {
    expect(deriveAgentStatus([aborted], "ready")).toBe("idle");
  });

  it("is not counted as a failure, and is not in the errors filter", () => {
    expect(summarizeEvents([aborted]).failed).toBe(0);
    expect(filterEvents([aborted], "errors")).toEqual([]);
  });
});

describe("deriveAgentStatus", () => {
  it("is idle on a settled turn with nothing wrong", () => {
    expect(deriveAgentStatus([computer("a", "screenshot")], "ready")).toBe("idle");
  });

  it("is thinking while the model streams with no tool in flight", () => {
    expect(deriveAgentStatus([computer("a", "screenshot")], "streaming")).toBe("thinking");
  });

  it("is acting while a tool call is pending, even mid-stream", () => {
    const events = [computer("a", "left_click", { status: "pending" })];
    expect(deriveAgentStatus(events, "streaming")).toBe("acting");
  });

  it("reports a failed chat request over anything derived from the log", () => {
    expect(deriveAgentStatus([], "error")).toBe("error");
  });

  it("surfaces a failure only while it is the most recent event", () => {
    const failed = computer("a", "left_click", { status: "error", error: "boom" });
    expect(deriveAgentStatus([failed], "ready")).toBe("error");
    // The agent recovered: the failure is history, not the current state.
    expect(deriveAgentStatus([failed, computer("b", "screenshot")], "ready")).toBe("idle");
  });
});

describe("countActions", () => {
  it("counts computer calls by VM action, not by tool name", () => {
    const events: AgentEvent[] = [
      computer("a", "screenshot"),
      computer("b", "left_click"),
      computer("c", "screenshot"),
      lifecycle("d", "session_created"),
    ];

    expect(countActions(events)).toEqual([
      { action: "screenshot", count: 2 },
      { action: "left_click", count: 1 },
    ]);
  });

  it("names bash and unknown tools after the tool itself", () => {
    const events = [
      { ...toolBase, id: "a", tool: "bash", command: "ls", status: "complete" },
      { ...toolBase, id: "b", tool: "other", toolName: "search", payload: {}, status: "complete" },
    ] as ToolEvent[];

    expect(countActions(events).map((entry) => entry.action).sort()).toEqual([
      "bash",
      "search",
    ]);
  });
});

describe("summarizeEvents", () => {
  it("counts failures from both families but tool calls from one", () => {
    const events: AgentEvent[] = [
      lifecycle("a", "session_created"),
      lifecycle("b", "chat_error", "relay down"),
      computer("c", "screenshot", { durationMs: 200 }),
      computer("d", "left_click", { status: "error", error: "boom", durationMs: 10 }),
      computer("e", "type", { status: "pending" }),
    ];

    expect(summarizeEvents(events)).toEqual({
      toolCalls: 3,
      pending: 1,
      failed: 2,
      totalDurationMs: 210,
    });
  });
});

describe("filterEvents", () => {
  const events: AgentEvent[] = [
    lifecycle("a", "session_created"),
    lifecycle("b", "sandbox_error", "no capacity"),
    computer("c", "screenshot"),
    computer("d", "left_click", { status: "error", error: "boom" }),
  ];

  it("splits the two families", () => {
    expect(filterEvents(events, "tools").map((event) => event.id)).toEqual(["c", "d"]);
    expect(filterEvents(events, "lifecycle").map((event) => event.id)).toEqual(["a", "b"]);
  });

  it("collects failures across both families", () => {
    expect(filterEvents(events, "errors").map((event) => event.id)).toEqual(["b", "d"]);
  });

  it("passes everything through unfiltered", () => {
    expect(filterEvents(events, "all")).toHaveLength(4);
  });
});
