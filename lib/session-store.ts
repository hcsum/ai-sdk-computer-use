import type { Message } from "ai";

import type { LifecycleEvent } from "./agent-events";
import { ABORTED } from "./utils";

/**
 * Sessions on top of `localStorage`.
 *
 * Two key spaces, on purpose. The index holds only what the sidebar renders, so
 * listing sessions never deserialises a single transcript; each session's
 * conversation lives under its own key, so writing the active session does not
 * rewrite the others and evicting an old one is a single `removeItem`.
 *
 * Everything here takes a `Storage` rather than reaching for `window`: the
 * quota and eviction behaviour is the part most worth testing, and that is only
 * testable if the storage can be faked.
 */

export const SESSION_INDEX_KEY = "cua.sessions.v1";

export const sessionBodyKey = (sessionId: string) => `cua.session.v1.${sessionId}`;

export const REDACTED_PERSISTED_TEXT = "Image redacted (persisted session)";

export const UNTITLED_SESSION = "New session";

const TITLE_MAX_LENGTH = 60;

/** What the sidebar needs. Deliberately small: this key is read on every write. */
export type SessionMeta = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * The session itself. `sandboxId` lives here rather than in the meta because it
 * is not identity — a sandbox lives at most 45 minutes, so a restored id is a
 * hint for reconnection that is just as likely to be dead.
 */
export type SessionBody = {
  messages: Message[];
  lifecycleEvents: LifecycleEvent[];
  sandboxId: string | null;
};

export const createSessionId = () =>
  `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const createSessionMeta = (now = new Date().toISOString()): SessionMeta => ({
  id: createSessionId(),
  title: UNTITLED_SESSION,
  createdAt: now,
  updatedAt: now,
});

const firstUserText = (messages: Message[]) => {
  const message = messages.find((candidate) => candidate.role === "user");
  if (!message) return "";
  const fromParts = message.parts
    ?.map((part) => (part.type === "text" ? part.text : ""))
    .join("");
  return (fromParts || message.content || "").trim();
};

/** The first thing the user asked, which is what they remember a session by. */
export const deriveSessionTitle = (messages: Message[]) => {
  const text = firstUserText(messages).replace(/\s+/g, " ");
  if (!text) return UNTITLED_SESSION;
  return text.length > TITLE_MAX_LENGTH
    ? `${text.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`
    : text;
};

type ToolInvocation = {
  toolCallId: string;
  toolName: string;
  state: string;
  args?: unknown;
  result?: unknown;
};

type ToolInvocationPart = {
  type: "tool-invocation";
  toolInvocation: ToolInvocation;
};

const isToolInvocationPart = (part: unknown): part is ToolInvocationPart => {
  if (!part || typeof part !== "object") return false;
  const candidate = part as Partial<ToolInvocationPart>;
  return candidate.type === "tool-invocation" && Boolean(candidate.toolInvocation);
};

const carriesImage = (result: unknown) => {
  if (!result || typeof result !== "object") return false;
  const data = (result as { data?: unknown }).data;
  if (!data || typeof data !== "object") return false;
  return (data as { type?: unknown }).type === "image";
};

const abortInvocation = (invocation: ToolInvocation): ToolInvocation =>
  invocation.state === "result"
    ? invocation
    : { ...invocation, state: "result", result: ABORTED };

const mapToolInvocations = (
  messages: Message[],
  transform: (invocation: ToolInvocation) => ToolInvocation,
): Message[] =>
  messages.map((message) => {
    const next: Message = {
      ...message,
      parts: message.parts?.map((part) =>
        isToolInvocationPart(part)
          ? { ...part, toolInvocation: transform(part.toolInvocation) }
          : part,
      ),
    } as Message;

    if (message.toolInvocations) {
      next.toolInvocations = message.toolInvocations.map(
        (invocation) =>
          transform(
            invocation as unknown as ToolInvocation,
          ) as unknown as NonNullable<Message["toolInvocations"]>[number],
      );
    }

    return next;
  });

/**
 * Stops a live transcript without making it a storage snapshot.
 *
 * `useChat.stop()` aborts the request, but it does not rewrite the already
 * streamed tool invocation. A session switch has to leave the outgoing
 * transcript resumable, so every non-result invocation becomes a normal
 * `tool_result` whose value explains that the user aborted it.
 */
export const abortUnfinishedToolInvocations = (messages: Message[]): Message[] =>
  mapToolInvocations(messages, abortInvocation);

/**
 * Screenshot bytes must never reach storage — a single 1024x768 PNG is hundreds
 * of kilobytes and the whole origin gets a few megabytes.
 *
 * The rule that makes this safe: **replace content, preserve protocol
 * structure.** Anthropic rejects any `tool_use` without a matching
 * `tool_result` with a 400, so the part, its `toolCallId` and its `result` field
 * all survive — only the image payload inside `data` is swapped for text. The
 * `ok: true` envelope stays too, since `experimental_toToolResultContent` reads
 * it first and would otherwise tell the model every past screenshot failed.
 *
 * The same rule covers a call that never returned. A session is persisted while
 * a run may still be in flight, and a `tool_use` frozen at `state: "call"` is a
 * 400 waiting to happen the next time that session is resumed. Storage is not a
 * live stream, so an unfinished call is recorded as aborted rather than left
 * dangling.
 *
 * Pure: `messages` is live React state, so nothing here may mutate it.
 */
const sanitiseInvocation = (invocation: ToolInvocation): ToolInvocation => {
  const aborted = abortInvocation(invocation);
  if (aborted !== invocation) return aborted;

  if (!carriesImage(invocation.result)) return invocation;

  return {
    ...invocation,
    result: {
      ...(invocation.result as Record<string, unknown>),
      ok: true,
      data: { type: "text", text: REDACTED_PERSISTED_TEXT },
    },
  };
};

/**
 * An assistant message carries its tool calls *twice*: in `parts`, and in the
 * legacy top-level `toolInvocations` array that `useChat` still populates. Both
 * hold the same `result` object, so sanitising only `parts` leaves a second,
 * untouched copy of every screenshot — which is how a four-message session
 * reached 1.3 MB. Both have to go through the same replacement.
 */
export const sanitiseMessagesForStorage = (messages: Message[]): Message[] =>
  mapToolInvocations(messages, sanitiseInvocation);

const parse = <T,>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export const readIndex = (storage: Storage): SessionMeta[] => {
  const index = parse<SessionMeta[]>(storage.getItem(SESSION_INDEX_KEY));
  if (!Array.isArray(index)) return [];
  return index.filter(
    (meta): meta is SessionMeta =>
      Boolean(meta) && typeof meta.id === "string" && typeof meta.title === "string",
  );
};

export const writeIndex = (storage: Storage, index: SessionMeta[]) => {
  try {
    storage.setItem(SESSION_INDEX_KEY, JSON.stringify(index));
  } catch (error) {
    console.warn("Could not persist the session index", error);
  }
};

/**
 * `Message.createdAt` is a `Date`, and JSON gives it back as a string. The turn
 * projector calls `createdAt.toISOString()`, so an unrevived message crashes the
 * timeline the moment a session is restored.
 */
const reviveMessage = (message: Message): Message =>
  message.createdAt ? { ...message, createdAt: new Date(message.createdAt) } : message;

export const readSessionBody = (
  storage: Storage,
  sessionId: string,
): SessionBody | null => {
  const body = parse<SessionBody>(storage.getItem(sessionBodyKey(sessionId)));
  if (!body) return null;
  return {
    messages: Array.isArray(body.messages) ? body.messages.map(reviveMessage) : [],
    lifecycleEvents: Array.isArray(body.lifecycleEvents) ? body.lifecycleEvents : [],
    sandboxId: typeof body.sandboxId === "string" ? body.sandboxId : null,
  };
};

const isQuotaError = (error: unknown) =>
  error instanceof Error &&
  (error.name === "QuotaExceededError" ||
    error.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    /quota/i.test(error.message));

/**
 * Writes one session, dropping the oldest *other* transcripts if the origin is
 * out of room. The index entries stay — a session whose body was evicted still
 * exists and still opens; it opens empty, which is a better failure than the
 * session vanishing from the sidebar.
 *
 * Returns the ids whose bodies were evicted, so the caller can say so.
 */
export const writeSessionBody = (
  storage: Storage,
  sessionId: string,
  body: SessionBody,
  index: SessionMeta[] = readIndex(storage),
): { ok: boolean; evicted: string[] } => {
  const payload = JSON.stringify({
    ...body,
    messages: sanitiseMessagesForStorage(body.messages),
  });

  const evictionOrder = [...index]
    .filter((meta) => meta.id !== sessionId)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .map((meta) => meta.id);

  const evicted: string[] = [];

  for (;;) {
    try {
      storage.setItem(sessionBodyKey(sessionId), payload);
      return { ok: true, evicted };
    } catch (error) {
      if (!isQuotaError(error)) {
        console.warn("Could not persist the session", error);
        return { ok: false, evicted };
      }
      const victim = evictionOrder.shift();
      if (!victim) {
        console.warn("Storage is full and no other session can be evicted", error);
        return { ok: false, evicted };
      }
      storage.removeItem(sessionBodyKey(victim));
      evicted.push(victim);
    }
  }
};

export const removeSessionBody = (storage: Storage, sessionId: string) => {
  storage.removeItem(sessionBodyKey(sessionId));
};
