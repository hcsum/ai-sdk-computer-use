"use client";

import { agentEventKey, isLifecycleFailure, type AgentEvent } from "@/lib/agent-events";
import { describeToolEvent, formatDuration } from "@/lib/tool-event-display";
import { cn } from "@/lib/utils";
import { Activity, CheckCircle2, CircleAlert, Clock3, MonitorUp } from "lucide-react";

type AgentEventPanelProps = {
  events: AgentEvent[];
  sandboxId: string | null;
  selectedEventId: string | null;
  onSelectEvent: (eventId: string | null) => void;
};

const getStatusIcon = (event: AgentEvent) => {
  if (event.kind === "lifecycle") return isLifecycleFailure(event) ? CircleAlert : MonitorUp;
  if (event.status === "pending") return Clock3;
  if (event.status === "error") return CircleAlert;
  return CheckCircle2;
};

const isFailure = (event: AgentEvent) =>
  event.kind === "lifecycle" ? isLifecycleFailure(event) : event.status === "error";

export function AgentEventPanel({
  events,
  sandboxId,
  selectedEventId,
  onSelectEvent,
}: AgentEventPanelProps) {
  const toolEvents = events.filter((event) => event.kind === "tool");
  const pendingCount = toolEvents.filter((event) => event.kind === "tool" && event.status === "pending").length;
  const failureCount = events.filter(isFailure).length;

  return (
    // The cap has to hold on every breakpoint: the panel sits between the
    // scrolling chat and the input, so an uncapped list pushes the input off
    // screen on narrow viewports.
    <aside className="max-h-[35dvh] overflow-y-auto border-t border-zinc-200 bg-zinc-50/70 px-4 py-3 xl:max-h-[40dvh]">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
            <Activity className="size-4" />
            Agent events
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            {toolEvents.length} tool calls · {pendingCount} pending
            {failureCount > 0 ? (
              <span className="text-red-600"> · {failureCount} failed</span>
            ) : null}
          </p>
        </div>
        <div className="max-w-36 truncate rounded-full border border-zinc-200 bg-white px-2 py-1 font-mono text-[11px] text-zinc-500">
          {sandboxId ?? "no sandbox"}
        </div>
      </div>

      <div className="space-y-2">
        {events.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 bg-white px-3 py-4 text-xs text-zinc-500">
            Events will appear after the session starts and the agent uses tools.
          </div>
        ) : (
          events.map((event) => {
            const StatusIcon = getStatusIcon(event);
            const { label, detail } =
              event.kind === "tool"
                ? describeToolEvent(event)
                : { label: event.label, detail: event.type };
            const duration = event.kind === "tool" ? formatDuration(event.durationMs) : null;
            // The cause line: a tool's error, or a failed lifecycle event's detail.
            const cause = event.kind === "tool" ? event.error : event.detail;

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
                    isFailure(event) && "bg-red-50 text-red-600",
                    event.kind === "lifecycle" && !isFailure(event) && "bg-blue-50 text-blue-600",
                    event.kind === "tool" && event.status === "pending" && "bg-amber-50 text-amber-600",
                    event.kind === "tool" && event.status === "complete" && "bg-emerald-50 text-emerald-600",
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
                        isFailure(event) && "text-red-500",
                      )}
                    >
                      {event.kind === "tool" ? event.status : "lifecycle"}
                    </span>
                  </div>
                  <div className="mt-1 truncate font-mono text-[11px] text-zinc-500">{detail}</div>
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
    </aside>
  );
}
