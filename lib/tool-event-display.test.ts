import { describe, expect, it } from "vitest";

import type { BashEvent, ComputerEvent, OtherToolEvent } from "./agent-events";
import {
  describeToolAction,
  describeToolEvent,
  formatDuration,
} from "./tool-event-display";

const common = {
  kind: "tool",
  id: "tool-1",
  messageId: "message-1",
  order: 0,
  timestamp: "2026-01-01T00:00:00.000Z",
  status: "complete",
} as const;

const computerEvent = (overrides: Partial<ComputerEvent>): ComputerEvent => ({
  ...common,
  tool: "computer",
  action: "screenshot",
  ...overrides,
});

describe("describeToolAction", () => {
  it("phrases a click with its coordinate", () => {
    expect(
      describeToolAction(computerEvent({ action: "left_click", coordinate: [397, 47] })),
    ).toMatchObject({ title: "Left clicking", detail: "at (397, 47)" });
  });

  it("quotes typed text", () => {
    expect(
      describeToolAction(computerEvent({ action: "type", text: "weather in dubai" })),
    ).toMatchObject({ title: "Typing", detail: '"weather in dubai"' });
  });

  it("drops the detail when the action carries no arguments", () => {
    expect(describeToolAction(computerEvent({ action: "screenshot" }))).toMatchObject({
      title: "Taking screenshot",
      detail: "",
    });
  });

  it("falls back to the raw action name for an unknown action", () => {
    expect(describeToolAction(computerEvent({ action: "triple_click" }))).toMatchObject({
      title: "triple_click",
      detail: "",
    });
  });

  it("truncates a long bash command", () => {
    const event: BashEvent = { ...common, tool: "bash", command: "echo ".repeat(20) };
    const { title, detail } = describeToolAction(event);
    expect(title).toBe("Running command");
    expect(detail).toHaveLength(41); // 40 characters plus the ellipsis
    expect(detail.endsWith("…")).toBe(true);
  });

  it("names an unrecognised tool after itself", () => {
    const event: OtherToolEvent = {
      ...common,
      tool: "other",
      toolName: "search",
      payload: { query: "dubai" },
    };
    expect(describeToolAction(event)).toMatchObject({
      title: "search",
      detail: '{"query":"dubai"}',
    });
  });
});

describe("describeToolEvent", () => {
  it("leads with the tool name and keeps the raw action", () => {
    expect(
      describeToolEvent(computerEvent({ action: "left_click", coordinate: [397, 47] })),
    ).toEqual({ label: "computer", detail: "left_click (397, 47)" });
  });

  it("labels a bash call with no command", () => {
    const event: BashEvent = { ...common, tool: "bash", command: "" };
    expect(describeToolEvent(event)).toEqual({ label: "bash", detail: "No command" });
  });
});

describe("formatDuration", () => {
  it("keeps sub-second timings in milliseconds", () => {
    expect(formatDuration(842)).toBe("842ms");
  });

  it("switches to seconds at a second", () => {
    expect(formatDuration(2148)).toBe("2.1s");
  });

  it("returns nothing when a call has not been timed", () => {
    expect(formatDuration(undefined)).toBeNull();
  });
});
