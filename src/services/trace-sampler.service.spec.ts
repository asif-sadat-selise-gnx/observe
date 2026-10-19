import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import { TraceSamplerService } from "./trace-sampler.service.js";

const sampler = (tracesSampleRate?: unknown, enabled?: boolean) =>
  new TraceSamplerService({
    tracesSampleRate,
    enabled,
  } as ObserveModuleOptionsWithDefaults);

describe("TraceSamplerService", () => {
  const httpAttributes = { url: "/orders", method: "GET" };

  describe("when no sample rate is configured", () => {
    it("captures everything", () => {
      // The safe default: an agent that silently dropped traces because nobody
      // set a rate would be indistinguishable from one that is not working.
      expect(sampler(undefined).shouldCapture("http", httpAttributes)).toBe(
        true,
      );
    });
  });

  describe("numeric sample rates", () => {
    it("captures everything at 1", () => {
      expect(sampler(1).shouldCapture("http", httpAttributes)).toBe(true);
    });

    it("captures everything above 1", () => {
      expect(sampler(5).shouldCapture("http", httpAttributes)).toBe(true);
    });

    it("captures everything at 0", () => {
      // 0 is falsy, so it takes the "not set" branch rather than dropping every
      // trace. Worth pinning: reading it as "sample nothing" is the obvious
      // guess, and it is not what happens.
      expect(sampler(0).shouldCapture("http", httpAttributes)).toBe(true);
    });

    it("captures roughly the configured proportion", () => {
      const random = vi.spyOn(Math, "random");
      const half = sampler(0.5);

      random.mockReturnValue(0.2);
      expect(half.shouldCapture("http", httpAttributes)).toBe(true);

      random.mockReturnValue(0.7);
      expect(half.shouldCapture("http", httpAttributes)).toBe(false);

      random.mockRestore();
    });

    it("is statistically close to the rate over many decisions", () => {
      const tenth = sampler(0.1);
      let captured = 0;
      for (let i = 0; i < 10_000; i++) {
        if (tenth.shouldCapture("http", httpAttributes)) {
          captured++;
        }
      }

      expect(captured).toBeGreaterThan(500);
      expect(captured).toBeLessThan(1500);
    });
  });

  describe("callback sample rates", () => {
    it("defers the decision to the callback", () => {
      const decide = vi.fn().mockReturnValue(false);

      expect(sampler(decide).shouldCapture("http", httpAttributes)).toBe(false);
      expect(decide).toHaveBeenCalledWith("http", httpAttributes);
    });

    it("passes the protocol through so a rule can vary by transport", () => {
      const decide = vi.fn().mockReturnValue(true);
      const service = sampler(decide);

      service.shouldCapture("rpc", { transport: "nats", ctx: {} });
      service.shouldCapture("grpc", { call: {} });

      expect(decide).toHaveBeenCalledWith("rpc", expect.any(Object));
      expect(decide).toHaveBeenCalledWith("grpc", expect.any(Object));
    });

    it("lets a callback keep the traces that matter and drop the noise", () => {
      // The reason a callback exists at all: sampling health checks out while
      // keeping every checkout.
      const decide = (_protocol: string, attributes: Record<string, any>) =>
        attributes.url !== "/health";
      const service = sampler(decide);

      expect(
        service.shouldCapture("http", { url: "/checkout", method: "POST" }),
      ).toBe(true);
      expect(
        service.shouldCapture("http", { url: "/health", method: "GET" }),
      ).toBe(false);
    });
  });

  describe("when the agent is disabled", () => {
    // Every protocol but jobs learns here that it should open no trace.
    it.each([
      ["no sample rate", undefined],
      ["a rate of 1", 1],
      ["a callback that keeps everything", () => true],
    ])("captures nothing, given %s", (_, rate) => {
      expect(sampler(rate, false).shouldCapture("http", httpAttributes)).toBe(
        false,
      );
    });

    it("does not consult the callback", () => {
      const decide = vi.fn().mockReturnValue(true);
      sampler(decide, false).shouldCapture("http", httpAttributes);

      expect(decide).not.toHaveBeenCalled();
    });
  });
});
