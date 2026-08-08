import { UIMessage } from "ai";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const ABORTED = "User aborted";

export const REDACTED_SCREENSHOT_TEXT = "Image redacted to save input tokens";

/**
 * Replaces screenshot payloads with a text placeholder before the request is
 * sent, keeping the `ComputerResult` envelope (`ok` + `data` + timing) intact.
 * `experimental_toToolResultContent` reads `ok` first, so a bare
 * `{ type: "text" }` here would be converted as a failure and the model would be
 * told every past screenshot errored.
 */
const redactedScreenshotResult = (result: unknown) => ({
  ...(result && typeof result === "object" ? result : {}),
  ok: true,
  data: { type: "text", text: REDACTED_SCREENSHOT_TEXT },
});

export const prunedMessages = (messages: UIMessage[]): UIMessage[] => {
  if (messages.at(-1)?.role === "assistant") {
    return messages;
  }

  return messages.map((message) => {
    // check if last message part is a tool invocation in a call state, then append a part with the tool result
    message.parts = message.parts.map((part) => {
      if (part.type === "tool-invocation") {
        if (
          part.toolInvocation.toolName === "computer" &&
          part.toolInvocation.args?.action === "screenshot"
        ) {
          return {
            ...part,
            toolInvocation: {
              ...part.toolInvocation,
              result: redactedScreenshotResult(
                "result" in part.toolInvocation
                  ? part.toolInvocation.result
                  : undefined,
              ),
            },
          };
        }
        return part;
      }
      return part;
    });
    return message;
  });
};
