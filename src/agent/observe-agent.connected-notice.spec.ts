import { afterEach, describe, expect, it, vi } from "vitest";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import { NodeRuntimeMetricsService } from "../services/node-runtime-metrics.service.js";
import { DEGRADED_MESSAGE_PREFIX } from "./degraded-ingest.protocol.js";
import { ObserveAgentSharedBuffer } from "./observe-agent.shared-buffer.js";
import { ObserveAgentWorker } from "./observe-agent.worker.js";

const HOSTED_NOTICE =
  "Observe is connected: the collector accepted this app's first batch. " +
  "Requests and jobs appear at https://observe.nestjs.com/dashboard as soon as the app serves them.";

/**
 * The line that tells a developer their setup works.
 *
 * Driven through `handleMessage`, like the span notices: the worker posts a
 * degraded verdict for every batch the collector answers 200, and nothing
 * else carries one.
 */
describe("ObserveAgentWorker's first accepted batch", () => {
  const boot = (endpoint?: string) => {
    const options = {
      serviceId: "svc",
      appKey: "k",
      appSecret: "s",
      runtimeMetrics: false,
      ...(endpoint ? { endpoint } : {}),
    } as ObserveModuleOptionsWithDefaults;
    const agent = new ObserveAgentWorker(
      new ObserveAgentSharedBuffer(options),
      options,
      {} as NodeRuntimeMetricsService,
    );
    const { logger } = agent as unknown as {
      logger: { log: () => void; warn: () => void; error: () => void };
    };
    const log = vi.spyOn(logger, "log").mockImplementation(() => undefined);
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    return { agent, log, error };
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("says so once, however many batches follow", () => {
    const { agent, log } = boot();

    for (let i = 0; i < 3; i++) {
      agent.handleMessage(`${DEGRADED_MESSAGE_PREFIX}false`);
      agent.handleMessage("Tracing and instrumentation data sent successfully");
    }

    expect(log.mock.calls).toEqual([[HOSTED_NOTICE]]);
  });

  it("counts a batch the collector keeps without its spans", () => {
    // Accepted is accepted: an account past its allowance is still connected.
    const { agent, log } = boot();

    agent.handleMessage(`${DEGRADED_MESSAGE_PREFIX}true`);

    expect(log.mock.calls).toEqual([[HOSTED_NOTICE]]);
  });

  it("stays quiet while the collector refuses the credentials", () => {
    const { agent, log, error } = boot();

    agent.handleMessage(
      "Error: Telemetry rejected (401). Check that appKey and appSecret are valid.",
    );

    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("names a collector of the user's own instead of the dashboard", () => {
    const { agent, log } = boot("http://localhost:3999");

    agent.handleMessage(`${DEGRADED_MESSAGE_PREFIX}false`);

    expect(log.mock.calls).toEqual([
      [
        "Observe is connected: http://localhost:3999 accepted this app's first batch.",
      ],
    ]);
  });
});
