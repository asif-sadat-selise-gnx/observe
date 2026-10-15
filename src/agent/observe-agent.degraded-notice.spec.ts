import { afterEach, describe, expect, it, vi } from "vitest";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import { NodeRuntimeMetricsService } from "../services/node-runtime-metrics.service.js";
import { DEGRADED_MESSAGE_PREFIX } from "./degraded-ingest.protocol.js";
import { ObserveAgentSharedBuffer } from "./observe-agent.shared-buffer.js";
import { ObserveAgentWorker } from "./observe-agent.worker.js";

/** The worker's line for one batch, as detached-observe-worker.ts posts it. */
const verdict = (value: "true" | "false" | "trimmed") =>
  `${DEGRADED_MESSAGE_PREFIX}${value}`;

const REDUCED_NOTICE =
  "Observe: this account has used its monthly allowance, so most traces now arrive without their spans. " +
  "Requests, jobs and errors are still recorded, and server errors, slow requests and failed jobs keep their full traces. " +
  "See /dashboard/billing/usage.";

const TRIMMED_NOTICE =
  "Observe: traces are now trimmed past this account's threshold to keep its bill down. " +
  "Requests, jobs and errors are still recorded, and server errors, slow requests and failed jobs keep their full traces. " +
  'To keep every trace, turn on "Keep full traces" at /dashboard/billing/usage.';

const RECOVERED_NOTICE = "Observe: spans are being recorded again.";

/**
 * What the agent tells the operator when the collector starts, changes or
 * stops withholding spans.
 *
 * Driven through `handleMessage`, where every line from the worker arrives,
 * with no thread behind it: worker-degraded-reply.spec.ts covers the other
 * half, from the collector's reply to the line.
 */
describe("ObserveAgentWorker's notice while spans are withheld", () => {
  const boot = () => {
    const options = {
      serviceId: "svc",
      appKey: "k",
      appSecret: "s",
      runtimeMetrics: false,
    } as ObserveModuleOptionsWithDefaults;
    const buffer = new ObserveAgentSharedBuffer(options);
    // Never started, so nothing reads the metrics service.
    const agent = new ObserveAgentWorker(
      buffer,
      options,
      {} as NodeRuntimeMetricsService,
    );
    const { logger } = agent as unknown as {
      logger: { warn: () => void; log: () => void };
    };
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(logger, "log").mockImplementation(() => undefined);
    return { agent, buffer, warn, log };
  };

  /** Several batches in a row, as an account in one state for days sends. */
  const batches = (agent: ObserveAgentWorker, line: string, count = 3) => {
    for (let i = 0; i < count; i++) {
      agent.handleMessage(line);
    }
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tells an account out of its allowance what is still kept, once", () => {
    const { agent, buffer, warn, log } = boot();

    // What an older collector sends: `degraded`, and no `trimmed`.
    batches(agent, verdict("true"));

    expect(warn.mock.calls).toEqual([[REDUCED_NOTICE]]);
    expect(log).not.toHaveBeenCalled();
    expect(buffer.isDegraded()).toBe(true);
  });

  it("tells a trimmed account why, and how to keep every trace, once", () => {
    const { agent, buffer, warn, log } = boot();

    batches(agent, verdict("trimmed"));

    expect(warn.mock.calls).toEqual([[TRIMMED_NOTICE]]);
    expect(log).not.toHaveBeenCalled();
    // Trimming withholds exactly the trees reduced ingest does.
    expect(buffer.isDegraded()).toBe(true);
  });

  it.each(["true", "trimmed"] as const)(
    "says spans are recorded again when `%s` gives way to full ingest",
    (value) => {
      const { agent, buffer, log } = boot();
      agent.handleMessage(verdict(value));

      batches(agent, verdict("false"));

      expect(log.mock.calls).toEqual([[RECOVERED_NOTICE]]);
      expect(buffer.isDegraded()).toBe(false);
    },
  );

  it("says nothing while every span is kept", () => {
    const { agent, buffer, warn, log } = boot();

    batches(agent, verdict("false"));

    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(buffer.isDegraded()).toBe(false);
  });

  it("speaks again when the reason changes, not otherwise", () => {
    /*
     * A Pro account that cancels goes from trimmed to Free's reduced ingest:
     * the same trees are withheld throughout, but why, and what the operator
     * can do about it, are not the same.
     */
    const { agent, buffer, warn, log } = boot();

    batches(agent, verdict("trimmed"));
    batches(agent, verdict("true"));
    batches(agent, verdict("trimmed"));

    expect(warn.mock.calls).toEqual([
      [TRIMMED_NOTICE],
      [REDUCED_NOTICE],
      [TRIMMED_NOTICE],
    ]);
    expect(log).not.toHaveBeenCalled();
    expect(buffer.isDegraded()).toBe(true);
  });
});
