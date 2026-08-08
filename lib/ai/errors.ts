import { APICallError, RetryError } from "ai";

const MAX_LENGTH = 300;

const truncate = (value: string) =>
  value.length > MAX_LENGTH ? `${value.slice(0, MAX_LENGTH)}…` : value;

/**
 * Relays report a dead upstream channel inside the response body, not in the
 * status text: a 503 whose body says `model_not_found / 无可用渠道` is a routing
 * problem, not an outage. Pull that message out so the client shows the reason
 * instead of "Service Unavailable".
 */
const upstreamMessage = (responseBody: string | undefined) => {
  if (!responseBody) return undefined;
  try {
    const parsed = JSON.parse(responseBody) as {
      error?: { message?: unknown };
      message?: unknown;
    };
    const message = parsed.error?.message ?? parsed.message;
    return typeof message === "string" && message ? message : undefined;
  } catch {
    return truncate(responseBody);
  }
};

/**
 * Renders a stream failure as one line a human can act on. Returns a string —
 * `toDataStreamResponse` JSON-stringifies whatever this produces, and an Error
 * object serialises to `{}`, which is how a real cause turns into a blank toast.
 */
export const describeStreamError = (error: unknown): string => {
  if (RetryError.isInstance(error)) {
    const attempts = error.errors.length;
    return `${describeStreamError(error.lastError)} (failed after ${attempts} attempts)`;
  }

  if (APICallError.isInstance(error)) {
    const reason = upstreamMessage(error.responseBody) ?? error.message;
    return `${error.statusCode ?? "request failed"}: ${truncate(reason)}`;
  }

  if (error instanceof Error) return truncate(error.message);

  return truncate(String(error));
};
