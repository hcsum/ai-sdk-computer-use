import { describe, expect, it } from "vitest";
import type { Message } from "ai";

import {
  agentEventKey,
  createToolEventProjector,
  createTurnEventProjector,
  deriveToolEvents,
  deriveTurnEvents,
  findToolPayload,
  getScreenshotBase64,
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
});

describe("getScreenshotBase64", () => {
  it("reads the payload the event deliberately left behind", () => {
    expect(
      getScreenshotBase64({ ok: true, data: { type: "image", data: "iVBORw0KGgo=" } }),
    ).toBe("iVBORw0KGgo=");
  });

  it("returns nothing for a text result, a failure, or a call still in flight", () => {
    expect(getScreenshotBase64({ ok: true, data: { type: "text", text: "hi" } })).toBeUndefined();
    expect(getScreenshotBase64({ ok: false, error: "boom" })).toBeUndefined();
    expect(getScreenshotBase64(undefined)).toBeUndefined();
  });
});

describe("findToolPayload", () => {
  const messages = [
    makeMessage(
      [
        toolPart({
          toolCallId: "tool-1",
          toolName: "computer",
          state: "result",
          args: { action: "left_click", coordinate: [1, 2] },
          result: { ok: true, data: { type: "text", text: "clicked" } },
        }),
      ],
      "message-1",
    ),
    makeMessage(
      [toolPart({ toolCallId: "tool-2", toolName: "bash", state: "call", args: { command: "ls" } })],
      "message-2",
    ),
  ];

  it("finds a call in a later message", () => {
    expect(findToolPayload(messages, "tool-2")).toEqual({
      args: { command: "ls" },
      result: undefined,
    });
  });

  it("returns the raw result the event deliberately summarised", () => {
    expect(findToolPayload(messages, "tool-1")?.result).toEqual({
      ok: true,
      data: { type: "text", text: "clicked" },
    });
  });

  it("returns nothing for an unknown call", () => {
    expect(findToolPayload(messages, "tool-404")).toBeUndefined();
  });
});

describe("agentEventKey", () => {
  it("keeps the two event families in separate key spaces", () => {
    const shared = "0193f0de-collision";
    const toolEvent = deriveToolEvents([
      makeMessage([
        toolPart({
          toolCallId: shared,
          toolName: "computer",
          state: "call",
          args: { action: "screenshot" },
        }),
      ]),
    ])[0];
    const lifecycleEvent: LifecycleEvent = {
      kind: "lifecycle",
      id: shared,
      order: 0,
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "session_created",
      label: "Session created",
    };

    expect(agentEventKey(toolEvent)).not.toBe(agentEventKey(lifecycleEvent));
  });
});

describe("deriveToolEvents, continued", () => {
  it("gives a user abort its own status, neither completed nor failed", () => {
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

    expect(events[0]).toMatchObject({ status: "aborted", error: ABORTED });
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

describe("deriveTurnEvents", () => {
  const message = (
    role: "user" | "assistant",
    parts: unknown[],
    id: string,
  ): Message => ({ id, role, content: "", parts }) as Message;

  const textPart = (text: string) => ({ type: "text", text });

  it("marks a user turn even though it carries no tool call", () => {
    const events = deriveTurnEvents([message("user", [textPart("hi")], "message-1")]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "turn", id: "message-1", role: "user" });
  });

  it("records no message content", () => {
    const events = deriveTurnEvents([
      message("user", [textPart("my bank password is hunter2")], "message-1"),
    ]);

    expect(JSON.stringify(events)).not.toContain("hunter2");
  });

  it("skips an assistant message that only made tool calls", () => {
    const events = deriveTurnEvents([
      message(
        "assistant",
        [toolPart({ toolCallId: "tool-1", toolName: "bash", state: "call", args: {} })],
        "message-1",
      ),
    ]);

    expect(events).toEqual([]);
  });

  it("marks an assistant message that also spoke", () => {
    const events = deriveTurnEvents([
      message(
        "assistant",
        [
          toolPart({ toolCallId: "tool-1", toolName: "bash", state: "call", args: {} }),
          textPart("Dubai is 38°C."),
        ],
        "message-1",
      ),
    ]);

    expect(events).toMatchObject([{ role: "assistant", messageId: "message-1" }]);
  });

  it("opens a message's block, ahead of the tool calls it made", () => {
    const messages = [
      message(
        "assistant",
        [
          textPart("Let me look."),
          toolPart({ toolCallId: "tool-1", toolName: "bash", state: "call", args: {} }),
        ],
        "message-1",
      ),
    ];

    expect(deriveTurnEvents(messages)[0].order).toBeLessThan(
      deriveToolEvents(messages)[0].order,
    );
  });

  it("keeps a message's timestamp stable across re-derivations", () => {
    let tick = 0;
    const project = createTurnEventProjector(() => `stamp-${tick++}`);
    const messages = [message("user", [textPart("hi")], "message-1")];

    expect(project(messages)[0].timestamp).toBe("stamp-0");
    expect(project(messages)[0].timestamp).toBe("stamp-0");
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
