import type { Logger } from "@nestjs/common";
import {
  deferTraceCompletion,
  getUserIdSafely,
} from "./deferred-trace-completion.js";

describe("deferred trace completion safeguards", () => {
  it("preserves a successful user id callback", () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    expect(getUserIdSafely(() => "user-123", [], null, logger, "http")).toBe(
      "user-123",
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("preserves the configured object's callback receiver", () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    const receiver = { userId: "receiver-user" };
    const callback = function (this: typeof receiver) {
      return this.userId;
    };
    expect(getUserIdSafely(callback, [], receiver, logger, "http")).toBe(
      "receiver-user",
    );
  });

  it("logs a throwing callback once and continues without a user id", () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    const callback = () => {
      throw new Error("callback failed");
    };
    expect(getUserIdSafely(callback, [], null, logger, "http")).toBeUndefined();
    expect(getUserIdSafely(callback, [], null, logger, "http")).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("contains errors that cannot be formatted safely", () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    const callback = () => {
      throw {
        toString: () => {
          throw new Error("format failed");
        },
      };
    };
    expect(getUserIdSafely(callback, [], null, logger, "http")).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("unprintable error"),
    );
  });

  it("consumes rejected deferred completion and warns once", async () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    deferTraceCompletion(
      () => Promise.reject(new Error("completion failed")),
      logger,
      "http",
    );
    deferTraceCompletion(
      () => Promise.reject(new Error("completion failed")),
      logger,
      "http",
    );
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
  });
});
