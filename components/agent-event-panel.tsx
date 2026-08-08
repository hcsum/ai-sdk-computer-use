"use client";

import { useMemo, useState } from "react";

import { agentEventKey, isLifecycleFailure, type AgentEvent } from "@/lib/agent-events";
import {
  countActions,
  deriveAgentStatus,
  EVENT_FILTERS,
  filterEvents,
  isFailedEvent,
  summarizeEvents,
  type ChatStatus,
  type EventFilter,
} from "@/lib/agent-event-stats";
import {
  describeToolEvent,
  describeTurnEvent,
  formatDuration,
} from "@/lib/tool-event-display";
import { cn } from "@/lib/utils";
import {
  Activity,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock3,
  MessageSquare,
  MonitorUp,
} from "lucide-react";

type AgentEventPanelProps = {
  events: AgentEvent[];
  sandboxId: string | null;
  sessionId: string;
  chatStatus: ChatStatus;
  selectedEventId: string | null;
  onSelectEvent: (eventId: string | null) => void;
};

const STATUS_STYLES = {
  idle: { dot: "bg-zinc-400", text: "text-zinc-500", label: "Idle" },
  thinking: { dot: "bg-blue-500 animate-pulse", text: "text-blue-600", label: "Thinking" },
  acting: { dot: "bg-amber-500 animate-pulse", text: "text-amber-600", label: "Acting" },
  error: { dot: "bg-red-500", text: "text-red-600", label: "Error" },
} as const;

const getStatusIcon = (event: AgentEvent) => {
  if (event.kind === "lifecycle") return isLifecycleFailure(event) ? CircleAlert : MonitorUp;
  if (event.kind === "turn") return event.role === "user" ? MessageSquare : Bot;
  if (event.status === "pending") return Clock3;
  if (event.status === "error") return CircleAlert;
  return CheckCircle2;
};

const describeEvent = (event: AgentEvent) => {
  switch (event.kind) {
    case "tool":
      return describeToolEvent(event);
    case "turn":
      return describeTurnEvent(event);
    default:
      return { label: event.label, detail: event.type };
  }
};

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div className="rounded-md border border-zinc-200 bg-white px-2 py-1.5">
    <div className="text-[10px] uppercase tracking-wide text-zinc-400">{label}</div>
    <div className="truncate font-mono text-[11px] text-zinc-800">{value}</div>
  </div>
);

export function AgentEventPanel({
  events,
  sandboxId,
  sessionId,
  chatStatus,
  selectedEventId,
  onSelectEvent,
}: AgentEventPanelProps) {
  // Collapsed by default: the transcript is the primary surface, and this is
  // instrumentation you open when you want it.
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState<EventFilter>("all");

  const status = deriveAgentStatus(events, chatStatus);
  const summary = useMemo(() => summarizeEvents(events), [events]);
  const actions = useMemo(() => countActions(events), [events]);
  const visibleEvents = useMemo(() => filterEvents(events, filter), [events, filter]);
  const statusStyle = STATUS_STYLES[status];

  return (
    <aside className="flex max-h-[45dvh] flex-col border-t border-zinc-200 bg-zinc-50/70">
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        className="flex shrink-0 items-center gap-2 px-4 py-2.5 text-left"
      >
        <Activity className="size-4 shrink-0 text-zinc-500" />
        <span className="text-sm font-semibold text-zinc-900">Agent events</span>
        <span className={cn("size-1.5 shrink-0 rounded-full", statusStyle.dot)} />
        <span className={cn("text-xs font-medium", statusStyle.text)}>
          {statusStyle.label}
        </span>
        <span className="ml-auto truncate text-[11px] text-zinc-500">
          {summary.toolCalls} calls · {summary.pending} pending
          {summary.failed > 0 ? (
            <span className="text-red-600"> · {summary.failed} failed</span>
          ) : null}
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-zinc-400 transition-transform",
            isOpen && "rotate-180",
          )}
        />
      </button>

      {isOpen ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
          <div className="mb-3 grid grid-cols-2 gap-1.5">
            <Stat label="Session" value={sessionId} />
            <Stat label="Sandbox" value={sandboxId ?? "none"} />
            <Stat label="VM time" value={formatDuration(summary.totalDurationMs) ?? "0ms"} />
            <Stat label="Events" value={String(events.length)} />
          </div>

          {actions.length > 0 ? (
            <div className="mb-3 flex flex-wrap gap-1">
              {actions.map(({ action, count }) => (
                <span
                  key={action}
                  className="rounded-full border border-zinc-200 bg-white px-2 py-0.5 font-mono text-[11px] text-zinc-600"
                >
                  {action} ×{count}
                </span>
              ))}
            </div>
          ) : null}

          <div className="mb-2 flex gap-1">
            {EVENT_FILTERS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setFilter(option)}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[11px] capitalize transition-colors",
                  option === filter
                    ? "border-zinc-800 bg-zinc-800 text-white"
                    : "border-zinc-200 bg-white text-zinc-500 hover:border-zinc-300",
                )}
              >
                {option}
              </button>
            ))}
          </div>

          <div className="space-y-2">
            {visibleEvents.length === 0 ? (
              <div className="rounded-lg border border-dashed border-zinc-300 bg-white px-3 py-4 text-xs text-zinc-500">
                {events.length === 0
                  ? "Events will appear after the session starts and the agent uses tools."
                  : "No events match this filter."}
              </div>
            ) : (
              visibleEvents.map((event) => {
                const StatusIcon = getStatusIcon(event);
                const { label, detail } = describeEvent(event);
                const duration =
                  event.kind === "tool" ? formatDuration(event.durationMs) : null;
                // The cause line: a tool's error, or a failed lifecycle event's detail.
                const cause =
                  event.kind === "tool"
                    ? event.error
                    : event.kind === "lifecycle"
                      ? event.detail
                      : undefined;
                const eventKey = agentEventKey(event);
                const isSelected = eventKey === selectedEventId;

                return (
                  <button
                    type="button"
                    key={eventKey}
                    aria-pressed={isSelected}
                    onClick={() => onSelectEvent(isSelected ? null : eventKey)}
                    className={cn(
                      "grid w-full grid-cols-[24px_1fr] gap-2 rounded-lg border bg-white p-2 text-left text-xs transition-colors",
                      isSelected
                        ? "border-blue-400 ring-1 ring-blue-200"
                        : "border-zinc-200 hover:border-zinc-300",
                    )}
                  >
                    <div
                      className={cn(
                        "mt-0.5 flex size-6 items-center justify-center rounded-full",
                        isFailedEvent(event) && "bg-red-50 text-red-600",
                        event.kind === "lifecycle" &&
                          !isFailedEvent(event) &&
                          "bg-blue-50 text-blue-600",
                        event.kind === "turn" && "bg-zinc-100 text-zinc-500",
                        event.kind === "tool" &&
                          event.status === "pending" &&
                          "bg-amber-50 text-amber-600",
                        event.kind === "tool" &&
                          event.status === "complete" &&
                          "bg-emerald-50 text-emerald-600",
                      )}
                    >
                      <StatusIcon className="size-3.5" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-zinc-900">{label}</span>
                        <span
                          className={cn(
                            "uppercase tracking-wide text-zinc-400",
                            isFailedEvent(event) && "text-red-500",
                          )}
                        >
                          {event.kind === "tool" ? event.status : event.kind}
                        </span>
                      </div>
                      <div className="mt-1 truncate font-mono text-[11px] text-zinc-500">
                        {detail}
                      </div>
                      {cause || duration ? (
                        <div
                          className={cn(
                            "mt-1 text-[11px]",
                            cause ? "text-red-600" : "truncate text-zinc-400",
                          )}
                        >
                          {cause ?? duration}
                        </div>
                      ) : null}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </aside>
  );
}
