import { describe, expect, it } from "vitest";
import { APICallError, RetryError } from "ai";

import { describeStreamError } from "./errors";

const relayError = () =>
  new APICallError({
    message: "Service Unavailable",
    url: "https://relay.example/v1/messages",
    requestBodyValues: {},
    statusCode: 503,
    responseBody: JSON.stringify({
      error: {
        code: "model_not_found",
        message: "分组 cc-sale 下模型 claude-sonnet-5 无可用渠道（distributor）",
        type: "packy_api_error",
      },
    }),
    isRetryable: true,
  });

describe("describeStreamError", () => {
  it("pulls the upstream cause out of the response body", () => {
    expect(describeStreamError(relayError())).toBe(
      "503: 分组 cc-sale 下模型 claude-sonnet-5 无可用渠道（distributor）",
    );
  });

  it("unwraps a retry error to the last real failure", () => {
    const error = new RetryError({
      message: "Failed after 3 attempts",
      reason: "maxRetriesExceeded",
      errors: [relayError(), relayError(), relayError()],
    });

    expect(describeStreamError(error)).toContain("无可用渠道");
    expect(describeStreamError(error)).toContain("failed after 3 attempts");
  });

  it("falls back to the status message when the body is not JSON", () => {
    const error = new APICallError({
      message: "Bad Gateway",
      url: "https://relay.example/v1/messages",
      requestBodyValues: {},
      statusCode: 502,
      responseBody: "<html>gateway down</html>",
    });

    expect(describeStreamError(error)).toBe("502: <html>gateway down</html>");
  });

  it("renders plain errors and non-errors as a single line", () => {
    expect(describeStreamError(new Error("boom"))).toBe("boom");
    expect(describeStreamError("boom")).toBe("boom");
  });

  it("truncates a long cause", () => {
    const error = new Error("x".repeat(500));
    expect(describeStreamError(error)).toHaveLength(301);
  });
});
