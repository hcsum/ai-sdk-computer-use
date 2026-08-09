import { describe, expect, it } from "vitest";
import type { Message } from "ai";

import { ABORTED } from "./utils";
import {
  deriveSessionTitle,
  readIndex,
  readSessionBody,
  REDACTED_PERSISTED_TEXT,
  removeSessionBody,
  sanitiseMessagesForStorage,
  sessionBodyKey,
  UNTITLED_SESSION,
  writeIndex,
  writeSessionBody,
  type SessionMeta,
} from "./session-store";

/** A `Storage` that can be told to refuse writes past a byte budget. */
const fakeStorage = (budget = Infinity): Storage => {
  const entries = new Map<string, string>();
  const used = () =>
    [...entries.entries()].reduce((total, [key, value]) => total + key.length + value.length, 0);

  return {
    get length() {
      return entries.size;
    },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      const without = used() - (entries.has(key) ? key.length + entries.get(key)!.length : 0);
      if (without + key.length + value.length > budget) {
        const error = new Error("quota");
        error.name = "QuotaExceededError";
        throw error;
      }
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
    clear: () => entries.clear(),
  };
};

const screenshotResult = {
  ok: true,
  durationMs: 210,
  startedAt: "2026-08-09T00:00:00.000Z",
  data: { type: "image", data: "iVBORw0KGgo=" },
};

const message = (parts: unknown[], overrides: Partial<Message> = {}): Message =>
  ({ id: "message-1", role: "assistant", content: "", parts, ...overrides }) as Message;

const toolPart = (toolInvocation: Record<string, unknown>) => ({
  type: "tool-invocation",
  toolInvocation,
});

const invocationOf = (sanitised: Message[], index = 0) =>
  (sanitised[0].parts![index] as unknown as {
    toolInvocation: Record<string, unknown>;
  }).toolInvocation;

describe("sanitiseMessagesForStorage", () => {
  it("replaces screenshot bytes but keeps the protocol envelope", () => {
    const sanitised = sanitiseMessagesForStorage([
      message([
        toolPart({
          toolCallId: "call-1",
          toolName: "computer",
          state: "result",
          args: { action: "screenshot" },
          result: screenshotResult,
        }),
      ]),
    ]);

    const invocation = invocationOf(sanitised);
    expect(invocation.toolCallId).toBe("call-1");
    expect(invocation.state).toBe("result");
    // A missing `tool_result` is a 400 from Anthropic, so the field survives.
    expect(invocation.result).toEqual({
      ok: true,
      durationMs: 210,
      startedAt: "2026-08-09T00:00:00.000Z",
      data: { type: "text", text: REDACTED_PERSISTED_TEXT },
    });
  });

  it("redacts an image from any action, not just an explicit screenshot", () => {
    const sanitised = sanitiseMessagesForStorage([
      message([
        toolPart({
          toolCallId: "call-1",
          toolName: "computer",
          state: "result",
          args: { action: "left_click", coordinate: [10, 20] },
          result: screenshotResult,
        }),
      ]),
    ]);

    expect(invocationOf(sanitised).result).toMatchObject({
      data: { type: "text", text: REDACTED_PERSISTED_TEXT },
    });
  });

  it("closes a call that never returned, so a resumed session is not a 400", () => {
    const sanitised = sanitiseMessagesForStorage([
      message([
        toolPart({
          toolCallId: "call-1",
          toolName: "computer",
          state: "call",
          args: { action: "screenshot" },
        }),
        toolPart({
          toolCallId: "call-2",
          toolName: "bash",
          state: "partial-call",
          args: { command: "ls" },
        }),
      ]),
    ]);

    expect(invocationOf(sanitised, 0)).toMatchObject({ state: "result", result: ABORTED });
    expect(invocationOf(sanitised, 1)).toMatchObject({ state: "result", result: ABORTED });
  });

  it("leaves text results and non-tool parts alone, and never mutates the input", () => {
    const original = message([
      { type: "text", text: "done" },
      toolPart({
        toolCallId: "call-1",
        toolName: "bash",
        state: "result",
        args: { command: "ls" },
        result: { ok: true, stdout: "a\nb" },
      }),
    ]);
    const snapshot = JSON.stringify(original);

    const sanitised = sanitiseMessagesForStorage([original]);

    expect(sanitised[0].parts![0]).toEqual({ type: "text", text: "done" });
    expect(invocationOf(sanitised, 1).result).toEqual({ ok: true, stdout: "a\nb" });
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  /**
   * `useChat` writes every tool call twice — into `parts` and into the legacy
   * top-level `toolInvocations`. Sanitising only `parts` left a second, full-size
   * copy of every screenshot on disk; one four-message session reached 1.3 MB.
   */
  it("redacts the legacy top-level toolInvocations, not just parts", () => {
    const invocation = {
      toolCallId: "call-1",
      toolName: "computer",
      state: "result",
      args: { action: "screenshot" },
      result: screenshotResult,
    };

    const sanitised = sanitiseMessagesForStorage([
      message([toolPart(invocation)], {
        toolInvocations: [invocation] as unknown as Message["toolInvocations"],
      }),
    ]);

    const persisted = sanitised[0].toolInvocations![0] as { result: unknown };
    expect(persisted.result).toEqual({
      ok: true,
      durationMs: 210,
      startedAt: "2026-08-09T00:00:00.000Z",
      data: { type: "text", text: REDACTED_PERSISTED_TEXT },
    });
  });

  /**
   * The invariant, stated once against the serialised form: whatever shape the
   * SDK invents next, no image payload may reach storage.
   */
  it("leaves no image payload anywhere in the serialised session", () => {
    const invocation = {
      toolCallId: "call-1",
      toolName: "computer",
      state: "result",
      args: { action: "screenshot" },
      result: screenshotResult,
    };

    const serialised = JSON.stringify(
      sanitiseMessagesForStorage([
        message([toolPart(invocation)], {
          toolInvocations: [invocation] as unknown as Message["toolInvocations"],
        }),
      ]),
    );

    expect(serialised).not.toContain('"type":"image"');
    expect(serialised).not.toContain("iVBORw0KGgo=");
  });
});

describe("deriveSessionTitle", () => {
  it("uses the first user message", () => {
    const messages = [
      message([{ type: "text", text: "hello" }], { id: "a", role: "assistant" }),
      message([{ type: "text", text: "  What's the weather in Dubai?  " }], {
        id: "b",
        role: "user",
      }),
      message([{ type: "text", text: "second question" }], { id: "c", role: "user" }),
    ];

    expect(deriveSessionTitle(messages)).toBe("What's the weather in Dubai?");
  });

  it("falls back when nothing has been asked yet", () => {
    expect(deriveSessionTitle([])).toBe(UNTITLED_SESSION);
  });

  it("truncates a long question", () => {
    const long = "a".repeat(200);
    const title = deriveSessionTitle([
      message([{ type: "text", text: long }], { id: "a", role: "user" }),
    ]);

    expect(title).toHaveLength(60);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("storage round trip", () => {
  it("reads back what was written, with screenshots redacted", () => {
    const storage = fakeStorage();
    const index: SessionMeta[] = [
      { id: "s1", title: "one", createdAt: "2026-08-01", updatedAt: "2026-08-02" },
    ];
    writeIndex(storage, index);
    writeSessionBody(
      storage,
      "s1",
      {
        messages: [
          message([
            toolPart({
              toolCallId: "call-1",
              toolName: "computer",
              state: "result",
              args: { action: "screenshot" },
              result: screenshotResult,
            }),
          ]),
        ],
        lifecycleEvents: [],
        sandboxId: "sbx-1",
      },
      index,
    );

    expect(readIndex(storage)).toEqual(index);
    const body = readSessionBody(storage, "s1")!;
    expect(body.sandboxId).toBe("sbx-1");
    expect(JSON.stringify(body)).not.toContain("iVBORw0KGgo=");
  });

  it("revives `createdAt` as a Date, which the turn projector calls into", () => {
    const storage = fakeStorage();
    writeSessionBody(
      storage,
      "s1",
      {
        messages: [
          message([{ type: "text", text: "hi" }], {
            role: "user",
            createdAt: new Date("2026-08-09T01:02:03.000Z"),
          }),
        ],
        lifecycleEvents: [],
        sandboxId: null,
      },
      [],
    );

    const restored = readSessionBody(storage, "s1")!.messages[0];
    expect(restored.createdAt).toBeInstanceOf(Date);
    expect(restored.createdAt?.toISOString()).toBe("2026-08-09T01:02:03.000Z");
  });

  it("survives a corrupt entry rather than throwing", () => {
    const storage = fakeStorage();
    storage.setItem(sessionBodyKey("s1"), "{not json");

    expect(readSessionBody(storage, "s1")).toBeNull();
    expect(readIndex(storage)).toEqual([]);
  });

  it("deletes a body without touching the rest", () => {
    const storage = fakeStorage();
    const body = { messages: [], lifecycleEvents: [], sandboxId: null };
    writeSessionBody(storage, "s1", body, []);
    writeSessionBody(storage, "s2", body, []);

    removeSessionBody(storage, "s1");

    expect(readSessionBody(storage, "s1")).toBeNull();
    expect(readSessionBody(storage, "s2")).not.toBeNull();
  });
});

describe("quota", () => {
  const filler = (size: number) => ({
    messages: [message([{ type: "text", text: "x".repeat(size) }])],
    lifecycleEvents: [],
    sandboxId: null,
  });

  it("evicts the least recently updated transcripts to make room", () => {
    const storage = fakeStorage(1200);
    const index: SessionMeta[] = [
      { id: "old", title: "old", createdAt: "2026-08-01", updatedAt: "2026-08-01" },
      { id: "mid", title: "mid", createdAt: "2026-08-02", updatedAt: "2026-08-02" },
      { id: "new", title: "new", createdAt: "2026-08-03", updatedAt: "2026-08-03" },
    ];
    writeSessionBody(storage, "old", filler(300), index);
    writeSessionBody(storage, "mid", filler(300), index);

    const result = writeSessionBody(storage, "new", filler(300), index);

    expect(result.ok).toBe(true);
    expect(result.evicted).toEqual(["old"]);
    expect(readSessionBody(storage, "old")).toBeNull();
    expect(readSessionBody(storage, "mid")).not.toBeNull();
    expect(readSessionBody(storage, "new")).not.toBeNull();
  });

  it("gives up rather than looping when nothing is left to evict", () => {
    const storage = fakeStorage(100);

    const result = writeSessionBody(storage, "only", filler(5000), []);

    expect(result).toEqual({ ok: false, evicted: [] });
  });
});
