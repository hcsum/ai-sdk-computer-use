"use client";

import { isLifecycleFailure, type AgentEvent, type ToolEvent } from "@/lib/agent-events";
import { cn } from "@/lib/utils";
import { Activity, CheckCircle2, CircleAlert, Clock3, MonitorUp } from "lucide-react";

type AgentEventPanelProps = {
  events: AgentEvent[];
  sandboxId: string | null;
};

const truncate = (value: string, max = 120) =>
  value.length > max ? `${value.slice(0, max)}…` : value;

const describeToolEvent = (event: ToolEvent) => {
  switch (event.tool) {
    case "computer": {
      const detail = event.coordinate
        ? ` (${event.coordinate.join(", ")})`
        : event.text
          ? ` ${event.text}`
          : "";
      return { label: "computer", detail: truncate(`${event.action}${detail}`) };
    }
    case "bash":
      return { label: "bash", detail: truncate(event.command) || "No command" };
    default:
      return {
        label: event.toolName,
        detail: event.payload ? truncate(JSON.stringify(event.payload)) : "No payload",
      };
  }
};

const getStatusIcon = (event: AgentEvent) => {
  if (event.kind === "lifecycle") return isLifecycleFailure(event) ? CircleAlert : MonitorUp;
  if (event.status === "pending") return Clock3;
  if (event.status === "error") return CircleAlert;
  return CheckCircle2;
};

const isFailure = (event: AgentEvent) =>
  event.kind === "lifecycle" ? isLifecycleFailure(event) : event.status === "error";

const formatDuration = (durationMs?: number) => {
  if (durationMs === undefined) return null;
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
};

export function AgentEventPanel({ events, sandboxId }: AgentEventPanelProps) {
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

            return (
              <div
                key={`${event.kind}-${event.id}`}
                className="grid grid-cols-[24px_1fr] gap-2 rounded-lg border border-zinc-200 bg-white p-2 text-xs"
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
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
