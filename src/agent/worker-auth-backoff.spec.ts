import { Worker } from "worker_threads";
import { createServer, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { parsePausedMessage } from "./degraded-ingest.protocol.js";
import {
  detachedWorkerData,
  detachedWorkerSource,
} from "./detached-observe-worker.assembly.js";
import { waitFor } from "../testing/observe-harness.js";

const HOUR_MS = 60 * 60 * 1000;

/**
 * How much longer than it should a pause may measure. The worker reads the
 * clock once the answer has crossed a local socket and been parsed - a
 * millisecond or two on an idle machine, more on a loaded CI runner.
 */
const SLACK_MS = 150;

/** One answer from the collector below. */
interface Answer {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/** One request the collector received, and when it answered it. */
interface Exchange {
  status: number;
  receivedAt: number;
  answeredAt: number;
}

/**
 * Plays the main thread: puts a batch in the shared slot whenever the worker
 * has emptied it, as a busy application's flushes do, so the worker has
 * something to send the moment a pause lapses. Takes the lock the way the
 * main thread does.
 */
const keepSlotFilled = (sharedBuffer: SharedArrayBuffer) => {
  const lock = new Int32Array(sharedBuffer, 0, 1);
  const length = new DataView(sharedBuffer, 4, 4);
  const bytes = new Uint8Array(sharedBuffer);
  const batch = new TextEncoder().encode(JSON.stringify({ traces: [] }));

  const timer = setInterval(() => {
    if (Atomics.compareExchange(lock, 0, 0, 1) !== 0) {
      return;
    }
    try {
      if (length.getUint32(0) === 0) {
        bytes.set(batch, 8);
        length.setUint32(0, batch.length);
      }
    } finally {
      Atomics.store(lock, 0, 0);
      Atomics.notify(lock, 0);
    }
  }, 5);
  return () => clearInterval(timer);
};

/**
 * A worker posting to `endpoint`, with every line it posts: the paused-until
 * protocol lines parsed, the rest as they came.
 *
 * Assembled from the same source and data as `ObserveAgentWorker` uses, as
 * every worker suite is - a copy assembled here would close over this
 * module's imports and pass whatever the real assembly forgot.
 */
const startWorker = (endpoint: string, flushInterval: number) => {
  const sharedBuffer = new SharedArrayBuffer(64 * 1024);
  const stopFilling = keepSlotFilled(sharedBuffer);
  const pausedUntil: number[] = [];
  const lines: string[] = [];

  const worker = new Worker(detachedWorkerSource(), {
    eval: true,
    workerData: detachedWorkerData({
      sharedBuffer,
      endpoint,
      appKey: "deleted-key",
      appSecret: "deleted-secret",
      flushInterval,
    }),
  });
  worker.on("message", (msg: string) => {
    const until = parsePausedMessage(msg);
    if (until === null) {
      lines.push(msg);
    } else {
      pausedUntil.push(until);
    }
  });

  return {
    pausedUntil,
    lines,
    async stop() {
      stopFilling();
      await worker.terminate();
    },
  };
};

/**
 * What the worker does once the collector has refused its credentials.
 *
 * It used to send every flush into the rejection for as long as the process
 * ran: 17,280 refused requests a day from one process at the default flush,
 * and 1.87M a day at the hosted collector on 2026-10-15. Each pause is read
 * off the paused-until line the worker announces it with, measured from the
 * answer that caused it - so the hour-long ones are checked without waiting
 * them out.
 */
describe("how the detached worker backs off from rejected credentials", () => {
  let collector: Server;
  let endpoint: string;
  /** Answered in order; the last one repeats. */
  let script: Answer[] = [{ status: 200 }];
  let exchanges: Exchange[] = [];
  let running: ReturnType<typeof startWorker> | undefined;

  const answerWith = (...answers: Answer[]) => {
    script = answers;
    exchanges = [];
  };

  /** The pause announced after the `index`th refusal, from its answer. */
  const pauseAfter = (index: number) => {
    const refusals = exchanges.filter((exchange) => exchange.status !== 200);
    return running!.pausedUntil[index] - refusals[index].answeredAt;
  };

  const refusals = (count: number) =>
    waitFor(
      () => (running?.pausedUntil.length ?? 0) >= count,
      5_000,
      `${count} refusal(s) to be announced`,
    );

  beforeAll(async () => {
    collector = createServer((req, res) => {
      const receivedAt = Date.now();
      req.resume();
      req.on("end", () => {
        const answer = script.length > 1 ? script.shift()! : script[0];
        exchanges.push({
          status: answer.status,
          receivedAt,
          answeredAt: Date.now(),
        });
        res.writeHead(answer.status, {
          "content-type": "application/json",
          ...answer.headers,
        });
        res.end(JSON.stringify(answer.body ?? {}));
      });
    });
    await new Promise<void>((resolve) =>
      collector.listen(0, "127.0.0.1", resolve),
    );
    endpoint = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  afterAll(async () => {
    collector.closeAllConnections();
    await new Promise<void>((resolve) => collector.close(() => resolve()));
  });

  it("backs off from the flush interval, doubling with each rejection in a row", async () => {
    answerWith({ status: 401, body: { message: "Invalid API key or secret" } });
    running = startWorker(endpoint, 100);

    await refusals(4);

    [100, 200, 400, 800].forEach((expected, index) => {
      expect(pauseAfter(index)).toBeGreaterThanOrEqual(expected);
      expect(pauseAfter(index)).toBeLessThan(expected + SLACK_MS);
    });
    // And nothing went out while a pause lasted, though a batch was waiting
    // the whole time.
    for (let index = 1; index < 4; index++) {
      expect(exchanges[index].receivedAt).toBeGreaterThanOrEqual(
        running.pausedUntil[index - 1],
      );
    }
  });

  it.each([
    {
      what: "a 401's Retry-After over its own schedule",
      status: 401,
      retryAfter: "1",
      expected: 1_000,
    },
    {
      what: "a 403's Retry-After over its own schedule",
      status: 403,
      retryAfter: "2",
      expected: 2_000,
    },
    {
      what: "at most an hour of a longer Retry-After",
      status: 401,
      retryAfter: "86400",
      expected: HOUR_MS,
    },
    {
      // Only delta-seconds is read: mis-parsing a date risks an enormous
      // pause, so it counts as no Retry-After at all.
      what: "its own schedule when Retry-After is a date",
      status: 401,
      retryAfter: "Wed, 21 Oct 2026 07:28:00 GMT",
      expected: 100,
    },
  ])("takes $what", async ({ status, retryAfter, expected }) => {
    answerWith({ status, headers: { "retry-after": retryAfter } });
    running = startWorker(endpoint, 100);

    await refusals(1);

    expect(pauseAfter(0)).toBeGreaterThanOrEqual(expected);
    expect(pauseAfter(0)).toBeLessThan(expected + SLACK_MS);
  });

  it("never pauses longer than an hour, however long the flush interval", async () => {
    answerWith({ status: 401 });
    running = startWorker(endpoint, 2 * HOUR_MS);

    await refusals(1);

    expect(pauseAfter(0)).toBeGreaterThanOrEqual(HOUR_MS);
    expect(pauseAfter(0)).toBeLessThan(HOUR_MS + SLACK_MS);
  });

  it("keeps doubling under a Retry-After, and stops at an hour", async () => {
    // From 40 minutes, the next step would be 80: the hourly probe instead.
    // The first answer's Retry-After keeps the wait short, and the backoff
    // advances underneath it all the same.
    answerWith(
      { status: 401, headers: { "retry-after": "1" } },
      { status: 401 },
    );
    running = startWorker(endpoint, 40 * 60 * 1000);

    await refusals(2);

    expect(pauseAfter(0)).toBeGreaterThanOrEqual(1_000);
    expect(pauseAfter(0)).toBeLessThan(1_000 + SLACK_MS);
    expect(pauseAfter(1)).toBeGreaterThanOrEqual(HOUR_MS);
    expect(pauseAfter(1)).toBeLessThan(HOUR_MS + SLACK_MS);
  });

  it("starts over from the flush interval once a batch is accepted", async () => {
    // A collector that refused a good key for a while - an outage of its
    // own - and then a key revoked later on. The later rejection is a new
    // run, not the next step of the old one.
    answerWith(
      { status: 401 },
      { status: 401 },
      { status: 200, body: { degraded: false } },
      { status: 401 },
    );
    running = startWorker(endpoint, 100);

    await refusals(3);

    expect(pauseAfter(0)).toBeLessThan(100 + SLACK_MS);
    expect(pauseAfter(1)).toBeGreaterThanOrEqual(200);
    expect(pauseAfter(2)).toBeGreaterThanOrEqual(100);
    expect(pauseAfter(2)).toBeLessThan(100 + SLACK_MS);
  });

  it("says so once, in full, and only counts the rejections after it", async () => {
    answerWith({ status: 401 });
    running = startWorker(endpoint, 50);

    await refusals(4);

    const reports = running.lines.filter((line) => line.startsWith("Error:"));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("Telemetry rejected (401)");
    expect(reports[0]).toContain("appKey and appSecret");
    expect(reports[0]).toContain("one attempt an hour");
  });

  // The 429 pause shares the Retry-After parsing and the pause itself with
  // the path above; these hold it to what it did before they did.
  it.each<{ what: string; headers: Record<string, string>; expected: number }>([
    {
      what: "five minutes without a Retry-After",
      headers: {},
      expected: 5 * 60 * 1000,
    },
    {
      what: "its Retry-After",
      headers: { "retry-after": "60" },
      expected: 60 * 1000,
    },
    {
      what: "at most an hour of a longer Retry-After",
      headers: { "retry-after": "7200" },
      expected: HOUR_MS,
    },
  ])("pauses a 429 for $what", async ({ headers, expected }) => {
    answerWith({
      status: 429,
      headers,
      body: { statusCode: 429, message: "Too Many Requests" },
    });
    running = startWorker(endpoint, 100);

    await refusals(1);

    expect(pauseAfter(0)).toBeGreaterThanOrEqual(expected);
    expect(pauseAfter(0)).toBeLessThan(expected + SLACK_MS);
  });
});
