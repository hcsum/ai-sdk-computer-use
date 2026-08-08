"use client";

import type { Message } from "ai";
import { AnimatePresence, motion } from "motion/react";
import { memo } from "react";
import equal from "fast-deep-equal";
import { Streamdown } from "streamdown";

import { ABORTED, cn } from "@/lib/utils";
import { agentEventKey, getScreenshotBase64, type ToolEvent } from "@/lib/agent-events";
import { describeToolAction } from "@/lib/tool-event-display";
import { CheckCircle, CircleSlash, Loader2, StopCircle } from "lucide-react";

const ToolStatusIcon = ({
  event,
  isLatestMessage,
  status,
}: {
  event: ToolEvent;
  isLatestMessage: boolean;
  status: "error" | "submitted" | "streaming" | "ready";
}) => {
  if (event.status === "pending") {
    // A call still marked pending on a settled turn never came back — that is a
    // stopped run, not one in flight.
    return isLatestMessage && status !== "ready" ? (
      <Loader2 className="animate-spin h-4 w-4 text-zinc-500" />
    ) : (
      <StopCircle className="h-4 w-4 text-red-500" />
    );
  }

  if (event.error === ABORTED) {
    return <CircleSlash size={14} className="text-amber-600" />;
  }

  return (
    <CheckCircle
      size={14}
      className={cn(event.status === "error" ? "text-red-600" : "text-green-600")}
    />
  );
};

const PurePreviewMessage = ({
  message,
  isLatestMessage,
  status,
  toolEvents,
  selectedEventId,
  onSelectEvent,
}: {
  message: Message;
  isLoading: boolean;
  status: "error" | "submitted" | "streaming" | "ready";
  isLatestMessage: boolean;
  /** The projected events for the whole conversation, keyed by tool call id. */
  toolEvents: Map<string, ToolEvent>;
  selectedEventId: string | null;
  onSelectEvent: (eventId: string | null) => void;
}) => {
  return (
    <AnimatePresence key={message.id}>
      <motion.div
        className="w-full mx-auto px-4 group/message"
        initial={{ y: 5, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        key={`message-${message.id}`}
        data-role={message.role}
      >
        <div
          className={cn(
            "flex gap-4 w-full group-data-[role=user]/message:ml-auto group-data-[role=user]/message:max-w-2xl",
            "group-data-[role=user]/message:w-fit",
          )}
        >
          <div className="flex flex-col w-full">
            {message.parts?.map((part, i) => {
              switch (part.type) {
                case "text":
                  return (
                    <motion.div
                      initial={{ y: 5, opacity: 0 }}
                      animate={{ y: 0, opacity: 1 }}
                      key={`message-${message.id}-part-${i}`}
                      className="flex flex-row gap-2 items-start w-full pb-4"
                    >
                      <div
                        className={cn("flex flex-col gap-4", {
                          "bg-secondary text-secondary-foreground px-3 py-2 rounded-xl":
                            message.role === "user",
                        })}
                      >
                        <Streamdown>{part.text}</Streamdown>
                      </div>
                    </motion.div>
                  );
                case "tool-invocation": {
                  const { toolCallId, state } = part.toolInvocation;
                  const event = toolEvents.get(toolCallId);
                  // Arguments stream in token by token. The projector holds a
                  // call back until they parse, and the card waits with it
                  // rather than rendering a half-decoded action.
                  if (!event) return null;

                  const { title, detail, icon: ActionIcon } = describeToolAction(event);
                  // Screenshot bytes deliberately never enter an event, so the
                  // one place that paints them reads back through `messages`.
                  const screenshot =
                    state === "result"
                      ? getScreenshotBase64(part.toolInvocation.result)
                      : undefined;
                  const awaitingScreenshot =
                    event.tool === "computer" &&
                    event.action === "screenshot" &&
                    event.status === "pending";

                  const eventKey = agentEventKey(event);
                  const isSelected = eventKey === selectedEventId;

                  return (
                    <motion.div
                      initial={{ y: 5, opacity: 0 }}
                      animate={{ y: 0, opacity: 1 }}
                      key={`message-${message.id}-part-${i}`}
                      role="button"
                      tabIndex={0}
                      aria-pressed={isSelected}
                      // Clicking the same card again clears the inspector, so a
                      // selection is never a state the user cannot get out of.
                      onClick={() => onSelectEvent(isSelected ? null : eventKey)}
                      onKeyDown={(keyEvent) => {
                        if (keyEvent.key !== "Enter" && keyEvent.key !== " ") return;
                        keyEvent.preventDefault();
                        onSelectEvent(isSelected ? null : eventKey);
                      }}
                      className={cn(
                        "flex flex-col gap-2 p-2 mb-3 text-sm bg-zinc-50 dark:bg-zinc-900 rounded-md border cursor-pointer transition-colors",
                        isSelected
                          ? "border-blue-400 ring-1 ring-blue-200 dark:border-blue-500"
                          : "border-zinc-200 dark:border-zinc-800 hover:border-zinc-300",
                      )}
                    >
                      <div className="flex-1 flex items-center justify-center">
                        <div className="flex items-center justify-center w-8 h-8 bg-zinc-50 dark:bg-zinc-800 rounded-full">
                          <ActionIcon className="w-4 h-4" />
                        </div>
                        <div className="flex-1">
                          <div className="font-medium font-mono flex items-baseline gap-2">
                            {title}
                            {detail && (
                              <span className="text-xs text-zinc-500 dark:text-zinc-400 font-normal">
                                {detail}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="w-5 h-5 flex items-center justify-center">
                          <ToolStatusIcon
                            event={event}
                            isLatestMessage={isLatestMessage}
                            status={status}
                          />
                        </div>
                      </div>
                      {screenshot ? (
                        <div className="p-2">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`data:image/png;base64,${screenshot}`}
                            alt="Screenshot of the agent's desktop"
                            className="w-full aspect-[1024/768] rounded-sm"
                          />
                        </div>
                      ) : awaitingScreenshot ? (
                        <div className="w-full aspect-[1024/768] rounded-sm bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
                      ) : null}
                    </motion.div>
                  );
                }

                default:
                  return null;
              }
            })}
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
};

export const PreviewMessage = memo(
  PurePreviewMessage,
  (prevProps, nextProps) => {
    if (prevProps.status !== nextProps.status) return false;
    // Selection is a click, not a token, so re-rendering every message on it is
    // cheap — and cheaper than tracking which message owns the selected event.
    if (prevProps.selectedEventId !== nextProps.selectedEventId) return false;
    if (prevProps.message.annotations !== nextProps.message.annotations)
      return false;
    if (!equal(prevProps.message.parts, nextProps.message.parts)) return false;
    // `toolEvents` is a fresh Map on every projection, so comparing it by
    // identity would defeat the memo entirely. It does not need comparing:
    // events are a pure function of the parts above, apart from a pending
    // call's provisional start time, which the projector holds stable.
    return true;
  },
);
