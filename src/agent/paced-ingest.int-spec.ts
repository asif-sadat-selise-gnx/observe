import { Controller, Get, INestApplication, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createObserveModule } from "../observe.module.js";
import {
  FakeCollector,
  startFakeCollector,
} from "../testing/fake-collector.js";
import {
  CapturedOutput,
  captureOutput,
  waitFor,
} from "../testing/observe-harness.js";
import { ObserveAgentSharedBuffer } from "./observe-agent.shared-buffer.js";

const PACED_NOTICE = "passed the Free plan's daily limit";
const REDUCED_NOTICE = "has used its monthly allowance";
const RECOVERED_NOTICE = "spans are being recorded again";

@Controller()
class PingController {
  @Get("ping")
  ping() {
    return { ok: true };
  }
}

/**
 * A Free account inside its allowance whose UTC day passed a tenth of it: the
 * collector accepts every batch and answers `{ degraded: true, paced: true }`
 * until 00:00 UTC.
 *
 * The real agent, from the collector's reply through the worker's line to the
 * main thread's notice and the trees it then withholds. The steps run in
 * order against one app, the way an account lives through the day.
 */
describe("a paced day, from the collector's reply to the operator's log", () => {
  let collector: FakeCollector;
  let output: CapturedOutput;
  let app: INestApplication;
  let buffer: ObserveAgentSharedBuffer;
  let baseUrl: string;
  let sent = 0;

  /** Sends a request under a trace id of its own, so its batch can be found. */
  const get = async (path: string): Promise<string> => {
    const traceId = `paced-${++sent}`;
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { "x-request-id": traceId },
    });
    await response.arrayBuffer();
    expect(response.status).toBe(200);
    return traceId;
  };

  const linesWith = (text: string) =>
    output.lines.filter((line) => line.includes(text));

  beforeAll(async () => {
    collector = await startFakeCollector();
    collector.answerWith({ degraded: true, paced: true });
    output = captureOutput();

    const { ObserveModule, ObserveInstrument } = createObserveModule();

    @Module({
      imports: [
        ObserveModule.forRoot({
          appKey: "test-key",
          appSecret: "test-secret",
          serviceId: "paced-app",
          endpoint: collector.url,
          flushInterval: 1000,
          runtimeMetrics: false,
          forwardLogs: false,
        }),
      ],
      controllers: [PingController],
    })
    class PacedModule {}

    // With Nest's logger on: the notice is a log line, and `logger: false`
    // would silence the very thing under test.
    app = await NestFactory.create(PacedModule, {
      instrument: ObserveInstrument,
    });
    await app.listen(0);
    baseUrl = await app.getUrl();
    buffer = app.get(ObserveAgentSharedBuffer, { strict: false });
  });

  afterAll(async () => {
    await app?.close();
    output?.restore();
    await collector?.close();
  });

  it("says the spans come back at 00:00 UTC, once, and never that the month is spent", async () => {
    // Several batches, each answered paced, as a busy afternoon sends.
    for (let i = 0; i < 3; i++) {
      await collector.waitForTrace(await get("/ping"));
    }
    await waitFor(
      () => linesWith(PACED_NOTICE).length > 0,
      5_000,
      "the paced notice to be logged",
    );

    expect(linesWith(PACED_NOTICE)).toHaveLength(1);
    expect(linesWith(PACED_NOTICE)[0]).toContain("until 00:00 UTC");
    // What 0.3.11 logged for this reply. The account is inside its allowance.
    expect(linesWith(REDUCED_NOTICE)).toEqual([]);
    expect(linesWith(RECOVERED_NOTICE)).toEqual([]);
  });

  it("withholds the trees reduced ingest withholds", async () => {
    await waitFor(
      () => buffer.isDegraded(),
      5_000,
      "the agent to act on the paced answer",
    );

    const traceId = await get("/ping");
    const batch = await collector.waitForTrace(traceId);

    const snapshot = batch.snapshots!.find((s) => s.ti === traceId);
    expect(snapshot).toBeDefined();
    // The request is still recorded; its fast, successful tree is not sent.
    expect(snapshot!.t).toEqual([]);
    expect(batch.truncatedSpans).toBeGreaterThan(0);
    expect(collector.violations).toEqual([]);
  });

  it("says spans are recorded again once the day turns, and sends them", async () => {
    // What the collector answers from 00:00 UTC.
    collector.answerWith({ degraded: false });

    await collector.waitForTrace(await get("/ping"));
    await waitFor(
      () => !buffer.isDegraded(),
      5_000,
      "the agent to act on the undegraded answer",
    );
    await waitFor(
      () => linesWith(RECOVERED_NOTICE).length > 0,
      5_000,
      "the recovery notice to be logged",
    );

    const traceId = await get("/ping");
    const batch = await collector.waitForTrace(traceId);
    const snapshot = batch.snapshots!.find((s) => s.ti === traceId);
    expect(snapshot!.t!.length).toBeGreaterThan(0);

    expect(linesWith(RECOVERED_NOTICE)).toHaveLength(1);
    expect(linesWith(PACED_NOTICE)).toHaveLength(1);
    expect(linesWith(REDUCED_NOTICE)).toEqual([]);
    expect(collector.violations).toEqual([]);
  });
});
