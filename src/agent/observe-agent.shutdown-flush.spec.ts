import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import { NodeRuntimeMetricsService } from "../services/node-runtime-metrics.service.js";
import { ObserveAgentSharedBuffer } from "./observe-agent.shared-buffer.js";
import { ObserveAgentWorker } from "./observe-agent.worker.js";

/** `FINAL_FLUSH_TIMEOUT_MS` in the worker. */
const FINAL_FLUSH_TIMEOUT_MS = 2000;

/** `MAX_LOGS_PER_TRANSACTION` in the shared buffer. */
const MAX_LOGS_PER_TRANSACTION = 250;

/**
 * Stands in for the worker thread on the other side of the shared buffer.
 *
 * The real thread's contract with the main thread is entirely in shared
 * memory: it reads the batch at offset 8, sends it, and zeroes the length at
 * offset 4 once the collector has answered. This does the same on a timer
 * (when `consuming`), recording each batch it took, and notes how many it had
 * taken when `terminate` was called - which is what "sent before shutdown"
 * comes down to.
 */
class FakeWorkerThread extends EventEmitter {
  readonly batches: Array<{
    logs?: Array<{ text: string }>;
    runtime?: unknown;
  }> = [];
  batchesAtTerminate: number | undefined;
  consuming = true;
  private readonly timer: NodeJS.Timeout;

  readonly terminate = vi.fn(async () => {
    this.batchesAtTerminate = this.batches.length;
    clearInterval(this.timer);
    this.emit("exit", 1);
    return 1;
  });

  constructor(private readonly sharedBuffer: SharedArrayBuffer) {
    super();
    this.timer = setInterval(() => this.consume(), 5);
  }

  /** Dies on its own, as a crashed thread would. */
  crash() {
    clearInterval(this.timer);
    this.emit("exit", 1);
  }

  stop() {
    clearInterval(this.timer);
  }

  private consume() {
    if (!this.consuming) {
      return;
    }
    const length = new DataView(this.sharedBuffer, 4, 4);
    const size = length.getUint32(0);
    if (size === 0) {
      return;
    }
    const bytes = new Uint8Array(this.sharedBuffer).slice(8, 8 + size);
    this.batches.push(JSON.parse(new TextDecoder().decode(bytes)));
    length.setUint32(0, 0);
  }
}

const logLines = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, index) => ({
    timestamp: Date.now(),
    text: `${prefix}-${index}`,
  }));

/**
 * Covers what `onApplicationShutdown` does with telemetry that is still
 * buffered: it used to terminate the worker without a flush, so up to one
 * flush interval of data - including the errors of the last requests a
 * process served - was lost on every deploy.
 */
describe("ObserveAgentWorker shutdown flush", () => {
  let fake: FakeWorkerThread | undefined;
  let metrics: NodeRuntimeMetricsService | undefined;

  const boot = (overrides: Partial<ObserveModuleOptionsWithDefaults> = {}) => {
    const options = {
      serviceId: "svc",
      appKey: "k",
      appSecret: "s",
      // Long enough that only the shutdown flush can deliver anything.
      flushInterval: 60_000,
      runtimeMetrics: false,
      forwardLogs: true,
      ...overrides,
    } as ObserveModuleOptionsWithDefaults;

    const buffer = new ObserveAgentSharedBuffer(options);
    metrics = new NodeRuntimeMetricsService(options);
    metrics.onModuleInit();

    const agent = new ObserveAgentWorker(buffer, options, metrics);
    const logger = (
      agent as unknown as {
        logger: { error: () => void; debug: () => void; log: () => void };
      }
    ).logger;
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    vi.spyOn(logger, "log").mockImplementation(() => undefined);

    const thread = new FakeWorkerThread(buffer.sharedBuffer);
    vi.spyOn(agent, "initializeWorker").mockImplementation(() => {
      (agent as unknown as { worker: unknown }).worker = thread;
    });
    agent.onModuleInit();
    fake = thread;

    return { agent, buffer, thread, error };
  };

  afterEach(async () => {
    fake?.stop();
    fake = undefined;
    await metrics?.onApplicationShutdown();
    metrics = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends what is buffered before terminating the worker", async () => {
    const { agent, buffer, thread } = boot();
    buffer.pushLogs(logLines(3, "last-words"));

    await agent.onApplicationShutdown();

    expect(thread.terminate).toHaveBeenCalledTimes(1);
    expect(thread.batchesAtTerminate).toBe(1);
    expect(thread.batches[0].logs?.map((log) => log.text)).toEqual([
      "last-words-0",
      "last-words-1",
      "last-words-2",
    ]);
  });

  it("waits for snapshots still queued behind a zero timer", async () => {
    const { agent, buffer, thread } = boot();
    // How every protocol records a finished request or job: from a
    // `setTimeout(0)` scheduled when it ended - here, just before shutdown.
    setTimeout(() => buffer.pushLogs(logLines(1, "just-finished")), 0);

    await agent.onApplicationShutdown();

    expect(thread.batchesAtTerminate).toBe(1);
    expect(thread.batches[0].logs?.[0].text).toBe("just-finished-0");
  });

  it("sends every batch a log backlog needs, not just the first", async () => {
    const { agent, buffer, thread } = boot();
    // More than one batch holds: the rest waits in the backlog, and only
    // repeated flushes bring it out.
    buffer.pushLogs(logLines(MAX_LOGS_PER_TRANSACTION * 2 + 10, "burst"));

    await agent.onApplicationShutdown();

    expect(thread.batchesAtTerminate).toBe(3);
    const sent = thread.batches.flatMap((batch) => batch.logs ?? []);
    expect(sent).toHaveLength(MAX_LOGS_PER_TRANSACTION * 2 + 10);
  });

  it("waits for the batch the worker is still sending instead of overwriting it", async () => {
    const { agent, buffer, thread } = boot();
    // A batch the last scheduled flush handed over, not yet taken.
    thread.consuming = false;
    buffer.pushLogs(logLines(1, "in-flight"));
    agent.flush();
    buffer.pushLogs(logLines(1, "still-buffered"));

    const shutdown = agent.onApplicationShutdown();
    await new Promise((resolve) => setTimeout(resolve, 50));
    thread.consuming = true;
    await shutdown;

    expect(
      thread.batches.map((batch) => batch.logs?.map((log) => log.text)),
    ).toEqual([["in-flight-0"], ["still-buffered-0"]]);
    expect(thread.batchesAtTerminate).toBe(2);
  });

  it("includes a last runtime-metrics sample when runtime metrics are on", async () => {
    const { agent, buffer, thread } = boot({ runtimeMetrics: true });
    buffer.pushLogs(logLines(1, "before"));

    await agent.onApplicationShutdown();

    expect(thread.batchesAtTerminate).toBe(thread.batches.length);
    expect(thread.batches.at(-1)?.runtime).toBeDefined();
  });

  it("terminates anyway when the worker never finishes the send", async () => {
    vi.useFakeTimers();
    const { agent, buffer, thread } = boot();
    // A collector that never answers: the worker keeps the slot filled, and
    // the request it is waiting on carries no timeout of its own.
    thread.consuming = false;
    buffer.pushLogs(logLines(1, "in-flight"));
    agent.flush();
    buffer.pushLogs(logLines(1, "never-written"));

    let finished = false;
    const shutdown = agent.onApplicationShutdown().then(() => {
      finished = true;
    });

    await vi.advanceTimersByTimeAsync(FINAL_FLUSH_TIMEOUT_MS - 100);
    expect(finished).toBe(false);

    await vi.advanceTimersByTimeAsync(200);
    await shutdown;

    expect(finished).toBe(true);
    expect(thread.terminate).toHaveBeenCalledTimes(1);
    // The unread batch was left as it was, not replaced by the later one.
    thread.consuming = true;
    (thread as unknown as { consume: () => void }).consume();
    expect(thread.batches[0].logs?.[0].text).toBe("in-flight-0");
  });

  it("terminates and does not throw when writing the final batch fails", async () => {
    const { agent, buffer, thread, error } = boot();
    buffer.pushLogs(logLines(1, "doomed"));
    vi.spyOn(buffer, "encodeAndWrite").mockImplementation(() => {
      throw new Error("Payload too large for shared buffer");
    });

    await expect(agent.onApplicationShutdown()).resolves.toBeUndefined();

    expect(thread.terminate).toHaveBeenCalledTimes(1);
    expect(thread.batches).toEqual([]);
    // Reported the way every scheduled flush reports it, once.
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("stops waiting as soon as the worker dies mid-flush", async () => {
    vi.useFakeTimers();
    const { agent, buffer, thread } = boot();
    thread.consuming = false;
    buffer.pushLogs(logLines(1, "stranded"));

    let finished = false;
    const shutdown = agent.onApplicationShutdown().then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(50);
    thread.crash();
    await vi.advanceTimersByTimeAsync(50);
    await shutdown;

    expect(finished).toBe(true);
    expect(thread.terminate).toHaveBeenCalledTimes(1);
  });

  it("sends nothing with the scaffold credentials, where no worker is started", async () => {
    const { agent, buffer } = boot({
      appKey: "YOUR_APP_KEY",
      appSecret: "YOUR_APP_SECRET",
    });
    // `onModuleInit` skips `initializeWorker` on this path, so the fake never
    // becomes the agent's worker.
    const encode = vi.spyOn(buffer, "encodeAndWrite");
    buffer.pushLogs(logLines(1, "placeholder"));

    await agent.onApplicationShutdown();

    expect(encode).not.toHaveBeenCalled();
    expect(fake?.terminate).not.toHaveBeenCalled();
  });
});
