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

@Controller()
class PingController {
  @Get("ping")
  ping() {
    return { ok: true };
  }
}

/**
 * A busy service whose key has been deleted: the collector answers every
 * batch with a 401, and there is always a fresh batch to send.
 *
 * Every flush used to go out into the rejection - one refused request per
 * second here, 17,280 a day at the default flush, for as long as the process
 * ran. Now the agent waits one flush interval, then two, then four, up to an
 * hour between attempts.
 */
describe("rejected credentials, from the collector's 401 to the agent's backoff", () => {
  let collector: FakeCollector;
  let output: CapturedOutput;
  let app: INestApplication;
  let baseUrl: string;
  let traffic: NodeJS.Timeout | undefined;

  beforeAll(async () => {
    collector = await startFakeCollector();
    collector.answerWith(
      { statusCode: 401, message: "Invalid API key or secret" },
      401,
    );
    output = captureOutput();

    const { ObserveModule, ObserveInstrument } = createObserveModule();

    @Module({
      imports: [
        ObserveModule.forRoot({
          appKey: "deleted-key",
          appSecret: "deleted-secret",
          serviceId: "revoked-app",
          endpoint: collector.url,
          // The agent's floor, and so the first pause.
          flushInterval: 1000,
          runtimeMetrics: false,
          forwardLogs: false,
        }),
      ],
      controllers: [PingController],
    })
    class RevokedModule {}

    app = await NestFactory.create(RevokedModule, {
      instrument: ObserveInstrument,
    });
    await app.listen(0);
    baseUrl = await app.getUrl();

    // Ten requests a second, so every flush has a batch to hand over and only
    // the backoff can explain a flush that sends nothing.
    traffic = setInterval(() => {
      fetch(`${baseUrl}/ping`)
        .then((res) => res.arrayBuffer())
        .catch(() => undefined);
    }, 100);
  });

  afterAll(async () => {
    clearInterval(traffic);
    await app?.close();
    output?.restore();
    await collector?.close();
  });

  it("waits one flush interval, then two, then four, instead of sending every flush", async () => {
    await waitFor(
      () => collector.requests.length >= 4,
      15_000,
      "four rejected sends",
    );

    const sentAt = collector.requests.map((request) => request.at);
    const gaps = sentAt.slice(1, 4).map((at, index) => at - sentAt[index]);

    // Never sooner than the pause, and late by at most the flush that
    // refills the slot - without the backoff each gap would be one second.
    [1_000, 2_000, 4_000].forEach((pause, index) => {
      expect(gaps[index]).toBeGreaterThanOrEqual(pause);
      expect(gaps[index]).toBeLessThan(pause + 1_000);
    });
  });

  it("says why once, and keeps serving traffic", async () => {
    const complaints = output.lines.filter((line) =>
      line.includes("Telemetry rejected"),
    );
    expect(complaints).toHaveLength(1);
    expect(complaints[0]).toContain("appKey and appSecret");
    expect(complaints[0]).toContain("one attempt an hour");

    const res = await fetch(`${baseUrl}/ping`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
