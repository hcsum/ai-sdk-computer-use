"use client";

import { PreviewMessage } from "@/components/message";
import { getDesktopURL } from "@/lib/sandbox/utils";
import { useScrollToBottom } from "@/lib/use-scroll-to-bottom";
import { useChat } from "@ai-sdk/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/input";
import { toast } from "sonner";
import { ThemeToggle } from "@/components/theme-toggle";
import { AgentEventPanel } from "@/components/agent-event-panel";
import { DesktopPanel } from "@/components/desktop-panel";
import { EventInspector } from "@/components/event-inspector";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ABORTED, cn } from "@/lib/utils";
import {
  agentEventKey,
  createToolEventProjector,
  createTurnEventProjector,
  findToolPayload,
  lifecycleOrderFor,
  mergeAgentEvents,
  type LifecycleEvent,
} from "@/lib/agent-events";
import { SessionSidebar } from "@/components/session-sidebar";
import { useSessions, type LiveSessionState } from "@/lib/use-sessions";
import { PanelLeft } from "lucide-react";

const ChatHeader = ({ onToggleSessions }: { onToggleSessions?: () => void }) => (
  <div className="flex items-center justify-between border-b border-border bg-background px-4 py-3">
    <div className="flex items-center gap-2">
      {onToggleSessions ? (
        <button
          type="button"
          onClick={onToggleSessions}
          aria-label="Sessions"
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <PanelLeft className="size-4" />
        </button>
      ) : null}
      <span className="text-sm font-semibold tracking-tight">Computer Use Agent</span>
    </div>
    <ThemeToggle />
  </div>
);

/**
 * Stands in for a stored transcript during the single render between a session
 * becoming active and `setMessages` applying it. An empty conversation and a
 * conversation that has not been painted yet look identical otherwise, and the
 * first one is a lie.
 */
const TranscriptSkeleton = () => (
  <div className="space-y-6" aria-busy="true" aria-label="Restoring conversation">
    {[70, 45, 60].map((width, index) => (
      <div
        key={width}
        className={cn("flex flex-col gap-2", index % 2 === 1 && "items-end")}
      >
        <div className="h-4 w-24 animate-pulse rounded bg-muted" />
        <div
          className="h-16 animate-pulse rounded-xl bg-muted"
          style={{ width: `${width}%` }}
        />
      </div>
    ))}
  </div>
);

const killSandbox = (sandboxId: string) => {
  // `sendBeacon` because this also has to work from an unload handler.
  navigator.sendBeacon(`/api/kill-desktop?sandboxId=${encodeURIComponent(sandboxId)}`);
};

export default function Chat() {
  // Create separate refs for mobile and desktop to ensure both scroll properly
  const [desktopContainerRef, desktopEndRef] = useScrollToBottom();
  const [mobileContainerRef, mobileEndRef] = useScrollToBottom();

  const [isInitializing, setIsInitializing] = useState(true);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [sandboxId, setSandboxId] = useState<string | null>(null);
  const [lifecycleEvents, setLifecycleEvents] = useState<LifecycleEvent[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  // Two different things: the rail narrows to initials on desktop, and opens as
  // a drawer below `xl`, where there is no width to give it.
  const [isSessionRailCollapsed, setIsSessionRailCollapsed] = useState(false);
  const [isSessionListOpen, setIsSessionListOpen] = useState(false);
  // Lifecycle events are ordered against the conversation, not the wall clock,
  // so recording one needs the message count as of *now* — async callbacks would
  // otherwise close over a stale `messages`.
  const messageCountRef = useRef(0);
  const sandboxIdRef = useRef<string | null>(null);
  sandboxIdRef.current = sandboxId;
  const projectToolEventsRef = useRef(createToolEventProjector());
  const projectTurnEventsRef = useRef(createTurnEventProjector());

  // Written during render, below — `useChat` needs the session id, so the live
  // state it owns can only be handed back to the session hook through a ref.
  const liveRef = useRef<LiveSessionState>({
    messages: [],
    lifecycleEvents: [],
    sandboxId: null,
  });
  const {
    sessions,
    activeSessionId,
    isRestoring,
    createSession,
    selectSession,
    deleteSession,
    takePendingRestore,
    scheduleFlush,
  } = useSessions(liveRef);

  const {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    status,
    stop: stopGeneration,
    setMessages,
    reload,
  } = useChat({
    api: "/api/chat",
    // Chat identity is the session, never the sandbox: a sandbox lives at most
    // 45 minutes, and keying the conversation on it would drop the transcript
    // the moment a session had to reconnect to a new desktop.
    id: activeSessionId ?? undefined,
    body: {
      sandboxId,
    },
    maxSteps: 30,
    onError: (error) => {
      console.error(error);
      // The server already rendered the upstream cause into `message` — surface
      // it, since "try again later" is wrong advice for a dead relay channel or
      // a model id the gateway cannot route.
      const reason = error.message?.trim() || "Please try again later.";
      recordLifecycleEvent("chat_error", "Model request failed", sandboxId, reason);
      toast.error("The model request failed", {
        description: reason,
        richColors: true,
        position: "top-center",
        duration: 10000,
        // The user turn is still in `messages` with no answer, so replaying it
        // is exactly what a retry means here.
        action: { label: "Retry", onClick: () => reload() },
      });
    },
  });

  const stop = () => {
    stopGeneration();

    const lastMessage = messages.at(-1);
    const lastMessageLastPart = lastMessage?.parts.at(-1);
    if (
      lastMessage?.role === "assistant" &&
      lastMessageLastPart?.type === "tool-invocation"
    ) {
      setMessages((prev) => [
        ...prev.slice(0, -1),
        {
          ...lastMessage,
          parts: [
            ...lastMessage.parts.slice(0, -1),
            {
              ...lastMessageLastPart,
              toolInvocation: {
                ...lastMessageLastPart.toolInvocation,
                state: "result",
                result: ABORTED,
              },
            },
          ],
        },
      ]);
    }
  };

  // Only "submitted" and "streaming" mean a turn is in flight. `!== "ready"`
  // also catches "error", which left the composer disabled with no way back.
  const isLoading = status === "submitted" || status === "streaming";
  messageCountRef.current = messages.length;
  liveRef.current = { messages, lifecycleEvents, sandboxId };
  const toolEvents = useMemo(() => projectToolEventsRef.current(messages), [messages]);
  // The transcript needs the same events the panel shows, looked up per call.
  const toolEventsById = useMemo(
    () => new Map(toolEvents.map((event) => [event.id, event])),
    [toolEvents],
  );
  const turnEvents = useMemo(() => projectTurnEventsRef.current(messages), [messages]);
  const agentEvents = useMemo(
    () => mergeAgentEvents(lifecycleEvents, [...toolEvents, ...turnEvents]),
    [lifecycleEvents, toolEvents, turnEvents],
  );

  const selectedEvent = useMemo(
    () => agentEvents.find((event) => agentEventKey(event) === selectedEventId) ?? null,
    [agentEvents, selectedEventId],
  );
  // Only the selected call's raw payload is ever pulled out of `messages` — it
  // can be a megabyte of screenshot, so nothing holds it but the inspector.
  const selectedPayload = useMemo(
    () =>
      selectedEvent?.kind === "tool"
        ? findToolPayload(messages, selectedEvent.id)
        : undefined,
    [messages, selectedEvent],
  );

  /**
   * Selecting from the debug panel also reveals the call in the transcript, so
   * the flat log and the conversation stay two views of one thing rather than
   * two places to look. Lifecycle events own no message and simply do not move
   * the transcript.
   *
   * Both layouts are mounted at once behind breakpoint classes, so the hidden
   * one is skipped by `offsetParent` rather than scrolled invisibly.
   */
  const selectAndRevealEvent = useCallback((eventId: string | null) => {
    setSelectedEventId(eventId);
    if (!eventId) return;

    requestAnimationFrame(() => {
      document
        .querySelectorAll<HTMLElement>(`[data-event-id="${CSS.escape(eventId)}"]`)
        .forEach((card) => {
          if (card.offsetParent === null) return;
          card.scrollIntoView({ behavior: "smooth", block: "center" });
        });
    });
  }, []);

  // Stable identity: `DesktopPanel` is memoised, and a handler rebuilt on every
  // streamed token would defeat that outright.
  const recordLifecycleEvent = useCallback(
    (
      type: LifecycleEvent["type"],
      label: string,
      nextSandboxId?: string | null,
      detail?: string,
    ) => {
      setLifecycleEvents((prev) => [
        ...prev,
        {
          kind: "lifecycle",
          id: crypto.randomUUID(),
          order: lifecycleOrderFor(messageCountRef.current),
          timestamp: new Date().toISOString(),
          type,
          label,
          detail,
          sandboxId: nextSandboxId,
        },
      ]);
    },
    [],
  );

  /**
   * Connects the desktop, preferring an id the session already carries. A
   * restored `sandboxId` is a hint, not a guarantee: `getDesktop` reuses it only
   * while that VM is still running and otherwise creates a fresh one, which is
   * the normal outcome for any session older than the sandbox lifetime.
   */
  const connectDesktop = useCallback(
    async (preferredId: string | null) => {
      try {
        setIsInitializing(true);
        const { streamUrl, id } = await getDesktopURL(preferredId ?? undefined);
        setStreamUrl(streamUrl);
        setSandboxId(id);
        recordLifecycleEvent(
          preferredId === id ? "sandbox_reconnected" : "sandbox_created",
          preferredId === id ? "Desktop reconnected" : "New desktop created",
          id,
        );
      } catch (err) {
        console.error("Failed to connect desktop:", err);
        recordLifecycleEvent(
          "sandbox_error",
          "Desktop connection failed",
          preferredId,
          err instanceof Error ? err.message : String(err),
        );
        toast.error("Failed to initialize desktop");
      } finally {
        setIsInitializing(false);
      }
    },
    [recordLifecycleEvent],
  );

  const refreshDesktop = useCallback(
    () => connectDesktop(sandboxIdRef.current),
    [connectDesktop],
  );

  /**
   * Applies a newly activated session. This is an effect rather than part of the
   * switch handler because `useChat` keys its state on the session id: calling
   * `setMessages` before the render that carries the new id would write the
   * incoming transcript into the outgoing session.
   */
  useEffect(() => {
    if (!activeSessionId) return;
    const restored = takePendingRestore();
    if (!restored) return;

    // Both projectors memoise per call/message id from the transcript they were
    // fed; carrying that across a switch would leak the old session's timings.
    projectToolEventsRef.current = createToolEventProjector();
    projectTurnEventsRef.current = createTurnEventProjector();

    // The outgoing desktop is freed rather than left to expire — the Hobby plan
    // allows ten concurrent sandboxes, and the session that owned this one has
    // already been written out, so the kill cannot be recorded against it.
    const outgoingSandboxId = sandboxIdRef.current;
    if (outgoingSandboxId) killSandbox(outgoingSandboxId);

    setMessages(restored.messages);
    setLifecycleEvents(restored.lifecycleEvents);
    // A bare `toolCallId` can name an event in the session being left.
    setSelectedEventId(null);
    setStreamUrl(null);
    setSandboxId(null);
    // Lifecycle ordering is relative to the message count, and the count for
    // this session is known now — the render that lowers it has not happened.
    messageCountRef.current = restored.messages.length;

    // Storage always holds a `session_created` event, so an empty log means a
    // session that has never been persisted: this one is new.
    if (restored.lifecycleEvents.length === 0) {
      recordLifecycleEvent("session_created", "Session created", null);
    }

    connectDesktop(restored.sandboxId);
  }, [
    activeSessionId,
    connectDesktop,
    recordLifecycleEvent,
    setMessages,
    takePendingRestore,
  ]);

  useEffect(scheduleFlush, [
    scheduleFlush,
    messages,
    lifecycleEvents,
    sandboxId,
  ]);

  // Kill desktop on page close. Registered once and reading the sandbox id from
  // a ref: a dependency on `sandboxId` would make the cleanup fire on every
  // reconnect and on every session switch, killing a desktop that just started.
  useEffect(() => {
    const killDesktop = () => {
      const id = sandboxIdRef.current;
      if (!id) return;

      killSandbox(id);
      // Fires on unload, so this rarely gets to paint — it exists so a session
      // that survives (bfcache restore) still shows why the desktop went away.
      recordLifecycleEvent("sandbox_killed", "Desktop killed", id);
    };

    // Detect iOS / Safari
    const isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

    // Choose exactly ONE event handler based on the browser
    if (isIOS || isSafari) {
      // For Safari on iOS, use pagehide which is most reliable
      window.addEventListener("pagehide", killDesktop);

      return () => {
        window.removeEventListener("pagehide", killDesktop);
        // Also kill desktop when component unmounts
        killDesktop();
      };
    } else {
      // For all other browsers, use beforeunload
      window.addEventListener("beforeunload", killDesktop);

      return () => {
        window.removeEventListener("beforeunload", killDesktop);
        // Also kill desktop when component unmounts
        killDesktop();
      };
    }
  }, [recordLifecycleEvent]);

  /**
   * Switching mid-run aborts it first. `sanitiseMessagesForStorage` would repair
   * a dangling `tool_use` on write anyway, but the request itself has to stop:
   * its result would otherwise land in `useChat`'s entry for the session being
   * left, after that session was written out.
   */
  const handleSelectSession = useCallback(
    (nextSessionId: string) => {
      if (nextSessionId === activeSessionId) return;
      if (isLoading) stop();
      setIsSessionListOpen(false);
      selectSession(nextSessionId);
    },
    // `stop` is rebuilt every render by design (it closes over `messages`), so
    // it is read through the call rather than depended on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSessionId, isLoading, selectSession],
  );

  const handleCreateSession = useCallback(() => {
    if (isLoading) stop();
    setIsSessionListOpen(false);
    createSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createSession, isLoading]);

  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      if (sessionId === activeSessionId && isLoading) stop();
      const orphanedSandboxId = deleteSession(sessionId);
      // Deleting a session the user is not in leaves a desktop nobody owns.
      if (orphanedSandboxId) killSandbox(orphanedSandboxId);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSessionId, deleteSession, isLoading],
  );

  return (
    <div className="flex h-dvh relative">
      {/* Mobile/tablet banner */}
      <div className="flex items-center justify-center fixed left-1/2 -translate-x-1/2 top-5 shadow-md text-xs mx-auto rounded-lg h-8 w-fit bg-blue-600 text-white px-3 py-2 text-left z-50 xl:hidden">
        <span>Headless mode</span>
      </div>

      {/* Resizable Panels */}
      <div className="hidden min-w-0 flex-1 xl:block">
        <ResizablePanelGroup direction="horizontal" className="h-full">
          {/* Chat: the session rail, the transcript, the composer and the debug
              panel. The rail lives inside this panel rather than beside it —
              picking a conversation is part of the chat surface, so the group
              stays the two panels the layout is about, chat left, VNC right. */}
          <ResizablePanel
            defaultSize={38}
            minSize={25}
            className="flex flex-col border-r border-border bg-background"
          >
            <ChatHeader />

            <div className="flex min-h-0 flex-1">
              <SessionSidebar
                sessions={sessions}
                activeSessionId={activeSessionId}
                onCreate={handleCreateSession}
                onSelect={handleSelectSession}
                onDelete={handleDeleteSession}
                collapsed={isSessionRailCollapsed}
                onToggleCollapsed={() =>
                  setIsSessionRailCollapsed((collapsed) => !collapsed)
                }
                className={cn(
                  "shrink-0 border-r border-border",
                  isSessionRailCollapsed ? "w-12" : "w-48",
                )}
              />

              <div className="flex min-w-0 flex-1 flex-col">
                <div
                  className="flex-1 space-y-6 py-4 overflow-y-auto px-4"
                  ref={desktopContainerRef}
                >
                  {isRestoring ? <TranscriptSkeleton /> : null}
                  {messages.map((message, i) => (
                    <PreviewMessage
                      message={message}
                      key={message.id}
                      isLoading={isLoading}
                      status={status}
                      isLatestMessage={i === messages.length - 1}
                      toolEvents={toolEventsById}
                      selectedEventId={selectedEventId}
                      onSelectEvent={setSelectedEventId}
                    />
                  ))}
                  <div ref={desktopEndRef} className="pb-2" />
                </div>

                <AgentEventPanel
                  events={agentEvents}
                  sandboxId={sandboxId}
                  sessionId={activeSessionId ?? ""}
                  chatStatus={status}
                  selectedEventId={selectedEventId}
                  onSelectEvent={selectAndRevealEvent}
                />

                <div className="bg-background">
                  <form onSubmit={handleSubmit} className="p-4">
                    <Input
                      handleInputChange={handleInputChange}
                      input={input}
                      isInitializing={isInitializing}
                      isLoading={isLoading}
                      status={status}
                      stop={stop}
                    />
                  </form>
                </div>
              </div>
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          {/* Desktop stream, with the inspector docked beneath it */}
          <ResizablePanel defaultSize={62} minSize={40}>
            <ResizablePanelGroup direction="vertical" className="h-full">
              <ResizablePanel
                defaultSize={70}
                minSize={30}
                className="bg-black relative items-center justify-center"
              >
                <DesktopPanel
                  streamUrl={streamUrl}
                  isInitializing={isInitializing}
                  onRefresh={refreshDesktop}
                />
              </ResizablePanel>

              <ResizableHandle withHandle />

              <ResizablePanel
                defaultSize={30}
                minSize={15}
                collapsible
                collapsedSize={0}
                className="border-t border-border"
              >
                <EventInspector event={selectedEvent} payload={selectedPayload} />
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      {/* Mobile View (Chat Only) */}
      <div className="w-full xl:hidden flex flex-col bg-background">
        <ChatHeader onToggleSessions={() => setIsSessionListOpen((open) => !open)} />

        {/* No room for a rail here, so the same component becomes a drawer. */}
        {isSessionListOpen ? (
          <div className="fixed inset-0 z-40 xl:hidden">
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setIsSessionListOpen(false)}
            />
            <SessionSidebar
              sessions={sessions}
              activeSessionId={activeSessionId}
              onCreate={handleCreateSession}
              onSelect={handleSelectSession}
              onDelete={handleDeleteSession}
              className="absolute inset-y-0 left-0 w-64 border-r border-border bg-background shadow-lg"
            />
          </div>
        ) : null}

        <div
          className="flex-1 space-y-6 py-4 overflow-y-auto px-4"
          ref={mobileContainerRef}
        >
          {isRestoring ? <TranscriptSkeleton /> : null}
          {messages.map((message, i) => (
            <PreviewMessage
              message={message}
              key={message.id}
              isLoading={isLoading}
              status={status}
              isLatestMessage={i === messages.length - 1}
              toolEvents={toolEventsById}
              selectedEventId={selectedEventId}
              onSelectEvent={setSelectedEventId}
            />
          ))}
          <div ref={mobileEndRef} className="pb-2" />
        </div>

        {/* No desktop panel to dock under here, so the inspector takes over the
            space above the event panel while something is selected. */}
        {selectedEvent ? (
          <div className="relative max-h-[45dvh] overflow-y-auto border-t border-border">
            <button
              type="button"
              onClick={() => setSelectedEventId(null)}
              className="absolute right-3 top-3 z-10 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              Close
            </button>
            <EventInspector event={selectedEvent} payload={selectedPayload} />
          </div>
        ) : null}

        <AgentEventPanel
          events={agentEvents}
          sandboxId={sandboxId}
          sessionId={activeSessionId ?? ""}
          chatStatus={status}
          selectedEventId={selectedEventId}
          onSelectEvent={selectAndRevealEvent}
        />

        <div className="bg-background">
          <form onSubmit={handleSubmit} className="p-4">
            <Input
              handleInputChange={handleInputChange}
              input={input}
              isInitializing={isInitializing}
              isLoading={isLoading}
              status={status}
              stop={stop}
            />
          </form>
        </div>
      </div>
    </div>
  );
}
