import { Worker } from "worker_threads";
import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEGRADED_MESSAGE_PREFIX,
  parseDegradedMessage,
} from "./degraded-ingest.protocol.js";
import {
  detachedWorkerData,
  detachedWorkerSource,
} from "./detached-observe-worker.assembly.js";

/** A shared buffer holding one batch, laid out as the agent lays it out. */
const bufferWithBatch = (json: string) => {
  const sharedBuffer = new SharedArrayBuffer(64 * 1024);
  const bytes = new Uint8Array(sharedBuffer);
  const length = new DataView(sharedBuffer, 4, 4);
  const encoded = new TextEncoder().encode(json);
  bytes.set(encoded, 8);
  length.setUint32(0, encoded.length);
  return sharedBuffer;
};

/**
 * The protocol line the worker posts for one accepted batch.
 *
 * Built from the same source and data `ObserveAgentWorker` uses, for the
 * reason worker-failure-reporting.spec.ts gives: the worker is eval'd with no
 * module scope, and a copy would pass whatever the real assembly forgot. An
 * `Error:` from the worker fails the wait - an accepted batch is not one.
 */
const verdictFor = async (endpoint: string) => {
  const worker = new Worker(detachedWorkerSource(), {
    eval: true,
    workerData: detachedWorkerData({
      sharedBuffer: bufferWithBatch(JSON.stringify({ traces: [] })),
      endpoint,
      appKey: "k",
      appSecret: "s",
    }),
  });

  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("worker posted no verdict")),
        5_000,
      );
      worker.on("message", (msg: string) => {
        if (msg.startsWith(DEGRADED_MESSAGE_PREFIX)) {
          clearTimeout(timer);
          resolve(msg);
        } else if (msg.startsWith("Error:")) {
          clearTimeout(timer);
          reject(new Error(msg));
        }
      });
      worker.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  } finally {
    await worker.terminate();
  }
};

type Respond = (req: IncomingMessage, res: ServerResponse) => void;

/** Accepts the batch: 200 with `body` as JSON, or with no body at all. */
const acceptWith =
  (body?: unknown): Respond =>
  (req, res) => {
    req.resume();
    req.on("end", () => {
      if (body === undefined) {
        res.writeHead(200);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  };

describe("what the detached worker makes of an accepted batch's reply", () => {
  let collector: Server;
  let endpoint: string;
  let respond: Respond = acceptWith({ degraded: false });

  beforeAll(async () => {
    collector = createServer((req, res) => respond(req, res));
    await new Promise<void>((resolve) =>
      collector.listen(0, "127.0.0.1", resolve),
    );
    endpoint = `http://127.0.0.1:${(collector.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => collector.close(() => resolve()));
  });

  // Value posted, the reply it is posted for, that reply's body, and what the
  // main thread reads the line as.
  it.each([
    // The only degraded reply before trimming existed. It has to keep meaning
    // what it meant, or every account on an older collector reads as
    // something else.
    [
      "true",
      "an older collector's degraded reply",
      { degraded: true },
      "reduced",
    ],
    [
      "trimmed",
      "a trimmed account's reply",
      { degraded: true, trimmed: true },
      "trimmed",
    ],
    ["false", "a reply keeping every span", { degraded: false }, "full"],
    ["false", "a reply with no body", undefined, "full"],
    // `trimmed` says why spans are discarded, never whether: `degraded` alone
    // decides that, as it always has.
    ["false", "`trimmed` without `degraded`", { trimmed: true }, "full"],
  ])(
    "posts `%s` for %s",
    async (value, _reply, body, mode) => {
      respond = acceptWith(body);

      const verdict = await verdictFor(endpoint);

      expect(verdict).toBe(`${DEGRADED_MESSAGE_PREFIX}${value}`);
      expect(parseDegradedMessage(verdict)).toBe(mode);
    },
    20_000,
  );
});
