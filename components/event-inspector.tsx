"use client";

import {
  getScreenshotBase64,
  isLifecycleFailure,
  type AgentEvent,
} from "@/lib/agent-events";
import { describeToolAction, formatDuration } from "@/lib/tool-event-display";
import { cn } from "@/lib/utils";
import { MousePointerSquareDashed } from "lucide-react";

type EventInspectorProps = {
  event: AgentEvent | null;
  /** The raw invocation behind a tool event; absent for lifecycle events. */
  payload?: { args: unknown; result: unknown };
};

/**
 * Long strings in a payload are screenshot base64. Printing one would freeze the
 * pane and tell the reader nothing, so it is collapsed to its size — the image
 * itself is rendered above.
 */
const formatPayload = (value: unknown) =>
  JSON.stringify(
    value,
    (_key, item) =>
      typeof item === "string" && item.length > 256
        ? `<${(item.length / 1024).toFixed(0)} KB elided>`
        : item,
    2,
  );

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-baseline justify-between gap-3 py-1">
    <span className="shrink-0 text-zinc-500">{label}</span>
    <span className="truncate font-mono text-[11px] text-zinc-800">{value}</span>
  </div>
);

const Block = ({ title, body }: { title: string; body: string }) => (
  <div>
    <div className="mb-1 text-[11px] uppercase tracking-wide text-zinc-400">{title}</div>
    <pre className="max-h-64 overflow-auto rounded-md border border-zinc-200 bg-zinc-50 p-2 font-mono text-[11px] leading-relaxed text-zinc-700">
      {body}
    </pre>
  </div>
);

const formatTime = (value?: string) =>
  value ? new Date(value).toLocaleTimeString(undefined, { hour12: false }) : undefined;

export function EventInspector({ event, payload }: EventInspectorProps) {
  if (!event) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-white px-6 text-center">
        <MousePointerSquareDashed className="size-5 text-zinc-300" />
        <p className="text-xs text-zinc-500">
          Select an event in the transcript or the debug panel to inspect its payload.
        </p>
      </div>
    );
  }

  const isFailure =
    event.kind === "lifecycle" ? isLifecycleFailure(event) : event.status === "error";
  const title =
    event.kind === "tool" ? describeToolAction(event).title : event.label;
  const status = event.kind === "tool" ? event.status : event.type;
  const screenshot =
    event.kind === "tool" ? getScreenshotBase64(payload?.result) : undefined;

  return (
    <div className="h-full overflow-y-auto bg-white px-4 py-3 text-xs">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="truncate text-sm font-semibold text-zinc-900">{title}</h2>
        <span
          className={cn(
            "shrink-0 rounded-full border px-2 py-0.5 text-[11px] uppercase tracking-wide",
            isFailure
              ? "border-red-200 bg-red-50 text-red-600"
              : "border-zinc-200 bg-zinc-50 text-zinc-500",
          )}
        >
          {status}
        </span>
      </div>

      <div className="mb-3 divide-y divide-zinc-100 border-y border-zinc-100">
        <Row label={event.kind === "tool" ? "Tool call id" : "Event id"} value={event.id} />
        {event.kind === "tool" ? <Row label="Message" value={event.messageId} /> : null}
        {/* The sort key. It is the first thing to look at when the timeline
            comes out in an order that seems wrong. */}
        <Row label="Order" value={String(event.order)} />
        {event.kind === "tool" ? (
          <>
            {formatTime(event.startedAt) ? (
              <Row label="Started" value={formatTime(event.startedAt)!} />
            ) : null}
            {formatTime(event.completedAt) ? (
              <Row label="Completed" value={formatTime(event.completedAt)!} />
            ) : null}
            {formatDuration(event.durationMs) ? (
              <Row label="Duration" value={formatDuration(event.durationMs)!} />
            ) : null}
          </>
        ) : (
          <>
            <Row label="Observed" value={formatTime(event.timestamp)!} />
            {event.sandboxId ? <Row label="Sandbox" value={event.sandboxId} /> : null}
          </>
        )}
      </div>

      {isFailure ? (
        <div className="mb-3 rounded-md border border-red-200 bg-red-50 p-2 text-[11px] text-red-700">
          {(event.kind === "tool" ? event.error : event.detail) ?? "Failed without a reason."}
        </div>
      ) : null}

      {screenshot ? (
        <div className="mb-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`data:image/png;base64,${screenshot}`}
            alt="Screenshot returned by this tool call"
            className="w-full rounded-md border border-zinc-200"
          />
        </div>
      ) : null}

      {event.kind === "tool" ? (
        <div className="space-y-3">
          <Block title="Arguments" body={formatPayload(payload?.args)} />
          <Block
            title="Result"
            body={
              payload?.result === undefined
                ? "Still running — no result yet."
                : formatPayload(payload.result)
            }
          />
        </div>
      ) : null}
    </div>
  );
}
