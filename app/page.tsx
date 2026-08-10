"use client";

import { PreviewMessage } from "@/components/message";
import { getDesktopURL } from "@/lib/sandbox/utils";
import { useScrollToBottom } from "@/lib/use-scroll-to-bottom";
import { useChat } from "@ai-sdk/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
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
import type { ImperativePanelHandle } from "react-resizable-panels";
import { cn } from "@/lib/utils";
import {
  agentEventKey,
  createToolEventProjector,
  createTurnEventProjector,
  findToolPayload,
  lifecycleOrderFor,
  mergeAgentEvents,
  type LifecycleEvent,
} from "@/lib/agent-events";
import { isUpstreamCapacityError } from "@/lib/ai/errors";
import { BootOverlay } from "@/components/boot-overlay";
import { DesktopDock } from "@/components/desktop-dock";
import { DockSection } from "@/components/dock-section";
import { SessionSidebar } from "@/components/session-sidebar";
import { describeEvent } from "@/lib/tool-event-display";
import { useMediaQuery } from "@/lib/use-media-query";
import { useSessions, type LiveSessionState } from "@/lib/use-sessions";
import { abortUnfinishedToolInvocations } from "@/lib/session-store";
import { PanelLeft, SquareDashedMousePointer } from "lucide-react";

/** The docked sections below `lg`, of which exactly one may be open. */
type DockName = "desktop" | "events" | "inspector";

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
  // Flips once the first connect attempt settles, successfully or not, and never
  // goes back — it gates the boot overlay, which is a first-run thing only.
  const [hasBooted, setHasBooted] = useState(false);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [sandboxId, setSandboxId] = useState<string | null>(null);
  const [lifecycleEvents, setLifecycleEvents] = useState<LifecycleEvent[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  // Two different things: the rail narrows to initials on desktop, and opens as
  // a drawer below `lg`, where there is no width to give it.
  const [isSessionRailCollapsed, setIsSessionRailCollapsed] = useState(false);
  const [isSessionListOpen, setIsSessionListOpen] = useState(false);
  // Below `lg` the desktop, the event log and the inspector are peers sharing
  // the bottom of the chat column, and at most one is open — there is not
  // enough height for two. Above `lg` each has its own space and none of this
  // applies: the event panel goes back to owning its own state.
  const [openDock, setOpenDock] = useState<DockName | null>(null);
  // Lifecycle events are ordered against the conversation, not the wall clock,
  // so recording one needs the message count as of *now* — async callbacks would
  // otherwise close over a stale `messages`.
  const messageCountRef = useRef(0);
  // Only ever read to expand the inspector when an event is selected — the
  // panel's size is otherwise the user's to set and this never fights it.
  const inspectorPanelRef = useRef<ImperativePanelHandle>(null);
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
  // Read in JS, not CSS: `DesktopPanel` must exist exactly once, and a second
  // copy hidden behind `lg:hidden` is a second VNC client on the same desktop.
  const isWide = useMediaQuery("(min-width: 1024px)");

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
      // The server rendered the upstream cause into `message`. It is kept whole
      // on the lifecycle event — the event log is where technical detail belongs
      // — while the toast gets wording matched to who can actually fix it.
      const reason = error.message?.trim() || "Please try again later.";
      const isUpstream = isUpstreamCapacityError(reason);
      recordLifecycleEvent("chat_error", "Model request failed", sandboxId, reason);
      toast.error(
        isUpstream ? "The model provider is busy" : "The model request failed",
        {
          description: isUpstream
            ? "The upstream API gateway had no channel available for this model. Nothing is wrong with your session — retry in a moment. Full response is in the event log."
            : reason,
          richColors: true,
          position: "top-center",
          duration: 10000,
          // The user turn is still in `messages` with no answer, so replaying it
          // is exactly what a retry means here.
          action: { label: "Retry", onClick: () => reload() },
        },
      );
    },
  });

  const stop = useCallback((options?: { sync?: boolean }) => {
    stopGeneration();

    const abortInTranscript = () => {
      setMessages((prev) => abortUnfinishedToolInvocations(prev));
    };

    if (options?.sync) {
      flushSync(abortInTranscript);
      return;
    }

    abortInTranscript();
  }, [setMessages, stopGeneration]);

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
   *
   * The inspector is collapsible, and a user who dragged it shut has no way to
   * know that selecting an event was supposed to do anything — the click lands,
   * the state changes, and nothing on screen moves. Expanding it is therefore
   * part of what "select" means here, exactly as it already is in the mobile
   * dock. Deselecting leaves it open on its empty state; collapsing the panel
   * out from under the cursor would be the same disappearance in reverse.
   */
  const selectEventOnDesktop = useCallback((eventId: string | null) => {
    setSelectedEventId(eventId);
    if (!eventId) return;
    if (inspectorPanelRef.current?.isCollapsed()) inspectorPanelRef.current.expand();
  }, []);

  const selectAndRevealEvent = useCallback((eventId: string | null) => {
    selectEventOnDesktop(eventId);
    if (!eventId) return;

    requestAnimationFrame(() => {
      document
        .querySelectorAll<HTMLElement>(`[data-event-id="${CSS.escape(eventId)}"]`)
        .forEach((card) => {
          if (card.offsetParent === null) return;
          card.scrollIntoView({ behavior: "smooth", block: "center" });
        });
    });
  }, [selectEventOnDesktop]);

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
        const desktop = await getDesktopURL(preferredId ?? undefined);
        if (!desktop.ok) {
          recordLifecycleEvent(
            "sandbox_error",
            "Desktop connection failed",
            preferredId,
            desktop.error,
          );
          toast.error("Failed to initialize desktop", {
            description: desktop.error,
            position: "top-center",
            duration: 10000,
          });
          return;
        }

        const { streamUrl, id } = desktop;
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
        setHasBooted(true);
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
   * Switching mid-run aborts it first, then flushes that aborted transcript
   * before activation changes. Without the synchronous step, React can batch the
   * stop update with the session switch: the old session is persisted with a
   * dangling call, while the abort patch races the new session id.
   */
  const handleSelectSession = useCallback(
    (nextSessionId: string) => {
      if (nextSessionId === activeSessionId) return;
      if (isLoading) stop({ sync: true });
      setIsSessionListOpen(false);
      selectSession(nextSessionId);
    },
    [activeSessionId, isLoading, selectSession, stop],
  );

  /**
   * Below `lg` a selection has somewhere to go: the inspector is its own docked
   * section, so opening it is what "select" means there. Deselecting leaves the
   * section open on its empty state rather than collapsing the strip under the
   * user's finger.
   */
  const handleSelectEventInDock = useCallback((eventId: string | null) => {
    setSelectedEventId(eventId);
    if (eventId) setOpenDock("inspector");
  }, []);

  const toggleDock = useCallback(
    (dock: DockName) => setOpenDock((open) => (open === dock ? null : dock)),
    [],
  );

  const handleCreateSession = useCallback(() => {
    if (isLoading) stop({ sync: true });
    setIsSessionListOpen(false);
    createSession();
  }, [createSession, isLoading, stop]);

  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      if (sessionId === activeSessionId && isLoading) stop({ sync: true });
      const orphanedSandboxId = deleteSession(sessionId);
      // Deleting a session the user is not in leaves a desktop nobody owns.
      if (orphanedSandboxId) killSandbox(orphanedSandboxId);
    },
    [activeSessionId, deleteSession, isLoading, stop],
  );

  return (
    <div className="flex h-dvh relative">
      {hasBooted ? null : <BootOverlay />}

      {/* Resizable Panels */}
      <div className="hidden min-w-0 flex-1 lg:block">
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
                      // Not `selectAndRevealEvent`: the card the user just
                      // clicked is already in front of them, and scrolling it to
                      // centre would move the transcript for no reason.
                      onSelectEvent={selectEventOnDesktop}
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
                  <form onSubmit={handleSubmit} className="px-4 pt-4 pb-8">
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
                {isWide ? (
                  <DesktopPanel
                    streamUrl={streamUrl}
                    isInitializing={isInitializing}
                    onRefresh={refreshDesktop}
                  />
                ) : null}
              </ResizablePanel>

              <ResizableHandle withHandle />

              <ResizablePanel
                ref={inspectorPanelRef}
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

      {/* Below `lg`: one column, with the desktop and the event log docked
          under it as mutually exclusive sections. */}
      <div className="w-full lg:hidden flex flex-col bg-background">
        <ChatHeader onToggleSessions={() => setIsSessionListOpen((open) => !open)} />

        {/* No room for a rail here, so the same component becomes a drawer. */}
        {isSessionListOpen ? (
          <div className="fixed inset-0 z-40 lg:hidden">
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
              onSelectEvent={handleSelectEventInDock}
            />
          ))}
          <div ref={mobileEndRef} className="pb-2" />
        </div>

        {!isWide ? (
          <DesktopDock
            isOpen={openDock === "desktop"}
            onToggle={() => toggleDock("desktop")}
            isInitializing={isInitializing}
            isConnected={Boolean(streamUrl)}
          >
            <DesktopPanel
              streamUrl={streamUrl}
              isInitializing={isInitializing}
              onRefresh={refreshDesktop}
            />
          </DesktopDock>
        ) : null}

        <AgentEventPanel
          events={agentEvents}
          sandboxId={sandboxId}
          sessionId={activeSessionId ?? ""}
          chatStatus={status}
          selectedEventId={selectedEventId}
          onSelectEvent={handleSelectEventInDock}
          isOpen={openDock === "events"}
          onToggle={() => toggleDock("events")}
        />

        <DockSection
          icon={SquareDashedMousePointer}
          title="Event details"
          isOpen={openDock === "inspector"}
          onToggle={() => toggleDock("inspector")}
          bodyClassName="overflow-y-auto"
          barContent={
            <span className="ml-auto truncate pr-2 text-[11px] text-muted-foreground">
              {selectedEvent ? describeEvent(selectedEvent).label : "nothing selected"}
            </span>
          }
        >
          <EventInspector event={selectedEvent} payload={selectedPayload} />
        </DockSection>

        <div className="bg-background">
          <form onSubmit={handleSubmit} className="px-4 pt-4 pb-8">
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
