"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Message } from "ai";

import type { LifecycleEvent } from "./agent-events";
import {
  createSessionMeta,
  deriveSessionTitle,
  readIndex,
  readSessionBody,
  removeSessionBody,
  writeIndex,
  writeSessionBody,
  type SessionBody,
  type SessionMeta,
} from "./session-store";

const PERSIST_DEBOUNCE_MS = 500;

const getStorage = (): Storage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Safari in private mode, or storage disabled by policy. Sessions still
    // work for the length of the page load; they just do not survive a reload.
    return null;
  }
};

const byRecencyDesc = (a: SessionMeta, b: SessionMeta) =>
  b.updatedAt.localeCompare(a.updatedAt);

/** The live state of whichever session is active, owned by the component. */
export type LiveSessionState = {
  messages: Message[];
  lifecycleEvents: LifecycleEvent[];
  sandboxId: string | null;
};

export type SessionsApi = {
  sessions: SessionMeta[];
  activeSessionId: string | null;
  createSession: () => void;
  selectSession: (sessionId: string) => void;
  /** Returns the deleted session's sandbox id, if it had one, for cleanup. */
  deleteSession: (sessionId: string) => string | null;
  /**
   * Hands over the state a newly activated session should be restored to, once
   * and only once. `null` when there is nothing to apply.
   *
   * This exists because the restore has to land *after* the render that carries
   * the new session id: `useChat` keys its state on that id, so calling
   * `setMessages` any earlier writes the incoming transcript into the outgoing
   * session. The consumer therefore drains this from an effect on
   * `activeSessionId`.
   */
  takePendingRestore: () => SessionBody | null;
  /**
   * Debounced write of the active session. Returns its own cleanup, so the
   * consumer can drive it straight from an effect:
   *
   * ```ts
   * useEffect(scheduleFlush, [scheduleFlush, messages, lifecycleEvents, sandboxId]);
   * ```
   *
   * The trigger lives with the consumer because those values only exist after
   * `useChat`, which in turn needs the session id from this hook.
   */
  scheduleFlush: () => () => void;
};

/**
 * Multiple sessions over one `useChat`.
 *
 * There is no in-memory map of sessions. `useChat` already owns the active
 * transcript and storage owns the rest, and a third copy of the same facts is
 * the standing invitation to desynchronise that the event model spends its
 * length avoiding. Switching is therefore always flush-then-restore, which also
 * means a switch and a page reload take the identical path — including the
 * screenshot redaction, so nobody discovers a divergence between them later.
 */
export const useSessions = (
  liveRef: RefObject<LiveSessionState>,
): SessionsApi => {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeSessionId;
  const sessionsRef = useRef<SessionMeta[]>(sessions);
  sessionsRef.current = sessions;
  const pendingRestoreRef = useRef<SessionBody | null>(null);
  const bootstrappedRef = useRef(false);

  /** Writes the active session out and refreshes its index entry. */
  const flush = useCallback(() => {
    const storage = getStorage();
    const sessionId = activeIdRef.current;
    if (!storage || !sessionId) return;

    const { messages, lifecycleEvents, sandboxId } = liveRef.current;

    const index = sessionsRef.current;
    const { evicted } = writeSessionBody(
      storage,
      sessionId,
      { messages, lifecycleEvents, sandboxId },
      index,
    );

    const title = deriveSessionTitle(messages);
    const next = index.map((meta) =>
      meta.id === sessionId
        ? { ...meta, title, updatedAt: new Date().toISOString() }
        : meta,
    );
    if (evicted.length) {
      console.warn("Evicted stored transcripts to stay under quota", evicted);
    }
    sessionsRef.current = next;
    writeIndex(storage, next);
    setSessions(next);
  }, [liveRef]);

  const activate = useCallback(
    (sessionId: string, body: SessionBody | null) => {
      pendingRestoreRef.current = body ?? {
        messages: [],
        lifecycleEvents: [],
        sandboxId: null,
      };
      setActiveSessionId(sessionId);
    },
    [],
  );

  const createSession = useCallback(() => {
    flush();
    const storage = getStorage();
    const meta = createSessionMeta();
    const next = [meta, ...sessionsRef.current];
    sessionsRef.current = next;
    setSessions(next);
    if (storage) writeIndex(storage, next);
    activate(meta.id, null);
  }, [activate, flush]);

  const selectSession = useCallback(
    (sessionId: string) => {
      if (sessionId === activeIdRef.current) return;
      flush();
      const storage = getStorage();
      activate(sessionId, storage ? readSessionBody(storage, sessionId) : null);
    },
    [activate, flush],
  );

  const deleteSession = useCallback(
    (sessionId: string) => {
      const storage = getStorage();
      const body = storage ? readSessionBody(storage, sessionId) : null;
      const isActive = sessionId === activeIdRef.current;
      // The active session's sandbox is bound to the component, which tears it
      // down on the switch; only an inactive one needs killing from here.
      const orphanedSandboxId = isActive
        ? null
        : (body?.sandboxId ?? null);

      const remaining = sessionsRef.current.filter((meta) => meta.id !== sessionId);
      sessionsRef.current = remaining;
      setSessions(remaining);
      if (storage) {
        removeSessionBody(storage, sessionId);
        writeIndex(storage, remaining);
      }

      if (!isActive) return orphanedSandboxId;

      const successor = [...remaining].sort(byRecencyDesc)[0];
      if (successor) {
        activate(
          successor.id,
          storage ? readSessionBody(storage, successor.id) : null,
        );
      } else {
        const meta = createSessionMeta();
        const next = [meta];
        sessionsRef.current = next;
        setSessions(next);
        if (storage) writeIndex(storage, next);
        activate(meta.id, null);
      }
      return orphanedSandboxId;
    },
    [activate],
  );

  const takePendingRestore = useCallback(() => {
    const pending = pendingRestoreRef.current;
    pendingRestoreRef.current = null;
    return pending;
  }, []);

  // Bootstrap: adopt the most recent stored session, or open the first one.
  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;

    const storage = getStorage();
    const index = storage ? readIndex(storage) : [];
    const mostRecent = [...index].sort(byRecencyDesc)[0];

    if (mostRecent) {
      sessionsRef.current = index;
      setSessions(index);
      activate(mostRecent.id, storage ? readSessionBody(storage, mostRecent.id) : null);
      return;
    }

    const meta = createSessionMeta();
    sessionsRef.current = [meta];
    setSessions([meta]);
    if (storage) writeIndex(storage, [meta]);
    activate(meta.id, null);
  }, [activate]);

  // Debounced, because the caller drives this on every streamed token and the
  // write sanitises and serialises the whole transcript.
  const scheduleFlush = useCallback(() => {
    const timer = setTimeout(flush, PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [flush]);

  // A tab closed inside the debounce window would otherwise lose the last turn.
  useEffect(() => {
    const onHide = () => flush();
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [flush]);

  return {
    sessions,
    activeSessionId,
    createSession,
    selectSession,
    deleteSession,
    takePendingRestore,
    scheduleFlush,
  };
};
