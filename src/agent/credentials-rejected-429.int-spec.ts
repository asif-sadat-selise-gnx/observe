import { Controller, Get, INestApplication, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { setTimeout as sleep } from "node:timers/promises";
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
 * How the collector answers credentials it has already refused: the first
 * batch gets a 401, and every one after it a 429 with
 * `code: "CREDENTIALS_REJECTED"` and `Retry-After: 3600`, so that agents too
 * old to back off from a 401 still pause on the 429.
 *
 * The 429's reason used to come out as "the account may be out of credits or
 * over budget", which sends the operator to the billing page for a problem
 * that is in their configuration.
 */
describe("credentials the collector has already rejected", () => {
  let collector: FakeCollector;
  let output: CapturedOutput;
  let app: INestApplication;
  let traffic: NodeJS.Timeout | undefined;

  const linesWith = (text: string) =>
    output.lines.filter((line) => line.includes(text));

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
    const baseUrl = await app.getUrl();

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

  it("says the credentials were rejected, not the account, and pauses for the hour asked", async () => {
    await waitFor(
      () => collector.requests.length >= 1,
      5_000,
      "the first send to be refused",
    );
    // The answer from here on. The agent's next send waits out the pause
    // that followed the 401 - one flush interval - so it gets this one.
    collector.answerWith(
      {
        statusCode: 429,
        code: "CREDENTIALS_REJECTED",
        message: "Invalid API key or secret",
      },
      429,
      { "retry-after": "3600" },
    );
    await waitFor(
      () => linesWith("rate-limited (429)").length > 0,
      5_000,
      "the 429 to be reported",
    );

    const [refusal] = linesWith("rate-limited (429)");
    expect(refusal).toContain("appKey and appSecret were rejected");
    expect(refusal).toContain("restart the process");
    expect(refusal).toContain("Pausing sends for 60 minute(s)");
    expect(refusal).not.toContain("out of credits");
    // The 401 said its piece once, before it.
    expect(linesWith("Telemetry rejected (401)")).toHaveLength(1);

    // Then nothing more is sent, though the traffic goes on.
    const sent = collector.requests.length;
    expect(sent).toBe(2);
    await sleep(2_500);
    expect(collector.requests.length).toBe(sent);
  });
});
