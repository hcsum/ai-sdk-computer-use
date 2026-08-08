import { describe, expect, it } from "vitest";
import type { Message } from "ai";

import {
  createToolEventProjector,
  deriveToolEvents,
  lifecycleOrderFor,
  mergeAgentEvents,
  type LifecycleEvent,
} from "./agent-events";
import { ABORTED, prunedMessages, REDACTED_SCREENSHOT_TEXT } from "./utils";

const makeMessage = (parts: unknown[], id = "message-1"): Message =>
  ({
    id,
    role: "assistant",
    content: "",
    parts,
  }) as Message;

const toolPart = (toolInvocation: Record<string, unknown>) => ({
  type: "tool-invocation",
  toolInvocation,
});

describe("deriveToolEvents", () => {
  it("derives pending tool calls from AI SDK message parts", () => {
    const events = deriveToolEvents([
      makeMessage([
        toolPart({
          toolCallId: "tool-1",
          toolName: "computer",
          state: "call",
          args: { action: "screenshot" },
        }),
      ]),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "tool-1",
      messageId: "message-1",
      tool: "computer",
      action: "screenshot",
      status: "pending",
    });
  });

  it("skips partial tool calls", () => {
    const events = deriveToolEvents([
      makeMessage([
        toolPart({
          toolCallId: "tool-1",
          toolName: "computer",
          state: "partial-call",
          args: '{"action',
        }),
      ]),
    ]);

    expect(events).toEqual([]);
  });

  it("reads execution metadata from completed tool results", () => {
    const events = deriveToolEvents([
      makeMessage([
        toolPart({
          toolCallId: "tool-1",
          toolName: "bash",
          state: "result",
          args: { command: "pwd" },
          result: {
            ok: true,
            stdout: "/tmp",
            startedAt: "2026-08-08T00:00:00.000Z",
            completedAt: "2026-08-08T00:00:00.123Z",
            durationMs: 123,
          },
        }),
      ]),
    ]);

    expect(events[0]).toMatchObject({
      tool: "bash",
      command: "pwd",
      stdout: "/tmp",
      status: "complete",
      timestamp: "2026-08-08T00:00:00.000Z",
      startedAt: "2026-08-08T00:00:00.000Z",
      completedAt: "2026-08-08T00:00:00.123Z",
      durationMs: 123,
    });
  });

  it("marks structured failed tool results as errors", () => {
    const events = deriveToolEvents([
      makeMessage([
        toolPart({
          toolCallId: "tool-1",
          toolName: "computer",
          state: "result",
          args: { action: "left_click" },
          result: {
            ok: false,
            error: "Coordinate required for left click action",
            startedAt: "2026-08-08T00:00:00.000Z",
            completedAt: "2026-08-08T00:00:00.010Z",
            durationMs: 10,
          },
        }),
      ]),
    ]);

    expect(events[0]).toMatchObject({
      status: "error",
      error: "Coordinate required for left click action",
      durationMs: 10,
    });
  });

  it("records a screenshot result without copying the base64 payload", () => {
    const events = deriveToolEvents([
      makeMessage([
        toolPart({
          toolCallId: "tool-1",
          toolName: "computer",
          state: "result",
          args: { action: "screenshot" },
          result: {
            ok: true,
            data: { type: "image", data: "iVBORw0KGgo=" },
            durationMs: 200,
          },
        }),
      ]),
    ]);

    expect(events[0]).toMatchObject({ tool: "computer", hasScreenshot: true });
    expect(JSON.stringify(events[0])).not.toContain("iVBORw0KGgo=");
  });

  it("treats a user abort as an error rather than a completed call", () => {
    const events = deriveToolEvents([
      makeMessage([
        toolPart({
          toolCallId: "tool-1",
          toolName: "computer",
          state: "result",
          args: { action: "screenshot" },
          result: ABORTED,
        }),
      ]),
    ]);

    expect(events[0]).toMatchObject({ status: "error", error: ABORTED });
  });

  it("keeps unknown tools in a payload-carrying variant", () => {
    const events = deriveToolEvents([
      makeMessage([
        toolPart({
          toolCallId: "tool-1",
          toolName: "future_tool",
          state: "call",
          args: { anything: 1 },
        }),
      ]),
    ]);

    expect(events[0]).toMatchObject({
      tool: "other",
      toolName: "future_tool",
      payload: { anything: 1 },
    });
  });

  it("keeps a pending call's provisional start stable across re-derivations", () => {
    let tick = 0;
    const project = createToolEventProjector(() => `stamp-${tick++}`);
    const messages = [
      makeMessage([
        toolPart({
          toolCallId: "tool-1",
          toolName: "computer",
          state: "call",
          args: { action: "screenshot" },
        }),
      ]),
    ];

    expect(project(messages)[0].timestamp).toBe("stamp-0");
    expect(project(messages)[0].timestamp).toBe("stamp-0");
  });

  it("lets server timing overwrite the provisional start once the result lands", () => {
    const project = createToolEventProjector(() => "client-stamp");
    const pending = [
      makeMessage([
        toolPart({
          toolCallId: "tool-1",
          toolName: "bash",
          state: "call",
          args: { command: "pwd" },
        }),
      ]),
    ];
    expect(project(pending)[0].timestamp).toBe("client-stamp");

    const resolved = [
      makeMessage([
        toolPart({
          toolCallId: "tool-1",
          toolName: "bash",
          state: "result",
          args: { command: "pwd" },
          result: { ok: true, stdout: "/tmp", startedAt: "2026-08-08T00:00:00.000Z" },
        }),
      ]),
    ];
    expect(project(resolved)[0].timestamp).toBe("2026-08-08T00:00:00.000Z");
  });
});

describe("mergeAgentEvents", () => {
  const lifecycleEvent = (
    id: string,
    order: number,
    type: LifecycleEvent["type"] = "sandbox_created",
  ): LifecycleEvent => ({
    kind: "lifecycle",
    id,
    order,
    timestamp: "2026-08-08T00:00:00.000Z",
    type,
    label: id,
    sandboxId: "sandbox-1",
  });

  it("interleaves lifecycle events at the point of the conversation they happened", () => {
    const toolEvents = deriveToolEvents([
      makeMessage(
        [toolPart({ toolCallId: "tool-1", toolName: "bash", state: "call", args: {} })],
        "message-1",
      ),
      makeMessage(
        [toolPart({ toolCallId: "tool-2", toolName: "bash", state: "call", args: {} })],
        "message-2",
      ),
    ]);

    const merged = mergeAgentEvents(
      [
        lifecycleEvent("session-start", lifecycleOrderFor(0), "session_created"),
        // observed while one message existed → belongs between the two tool calls
        lifecycleEvent("desktop-restart", lifecycleOrderFor(1)),
      ],
      toolEvents,
    );

    expect(merged.map((event) => event.id)).toEqual([
      "session-start",
      "tool-1",
      "desktop-restart",
      "tool-2",
    ]);
  });

  it("keeps insertion order for lifecycle events observed at the same point", () => {
    const merged = mergeAgentEvents(
      [
        lifecycleEvent("first", lifecycleOrderFor(0)),
        lifecycleEvent("second", lifecycleOrderFor(0), "sandbox_killed"),
      ],
      [],
    );

    expect(merged.map((event) => event.id)).toEqual(["first", "second"]);
  });
});

describe("prunedMessages", () => {
  it("redacts screenshots without turning them into tool failures", () => {
    const [message] = prunedMessages([
      {
        id: "message-1",
        role: "assistant",
        content: "",
        parts: [
          toolPart({
            toolCallId: "tool-1",
            toolName: "computer",
            state: "result",
            args: { action: "screenshot" },
            result: {
              ok: true,
              data: { type: "image", data: "iVBORw0KGgo=" },
              durationMs: 200,
            },
          }),
        ],
      },
      { id: "message-2", role: "user", content: "again", parts: [] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (message.parts[0] as any).toolInvocation.result;
    expect(result).toMatchObject({
      ok: true,
      data: { type: "text", text: REDACTED_SCREENSHOT_TEXT },
      durationMs: 200,
    });
  });
});
