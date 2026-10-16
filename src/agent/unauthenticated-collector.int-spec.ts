import { Controller, Get, INestApplication, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createObserveModule } from "../observe.module.js";
import {
  FakeCollector,
  startFakeCollector,
} from "../testing/fake-collector.js";
import { CapturedOutput, captureOutput } from "../testing/observe-harness.js";

@Controller()
class PingController {
  @Get("ping")
  ping() {
    return { ok: true };
  }
}

/**
 * No credentials, and a collector of the user's own - one in placeholder mode,
 * which takes batches without them. Only the hosted collector refuses those,
 * so only against it does the agent stay quiet; here it sends as it always
 * has, with the credential headers left off rather than sent empty.
 */
describe("no credentials, against a collector that takes batches without them", () => {
  let collector: FakeCollector;
  let output: CapturedOutput;
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    collector = await startFakeCollector();
    output = captureOutput();

    const { ObserveModule, ObserveInstrument } = createObserveModule();

    @Module({
      imports: [
        ObserveModule.forRoot({
          appKey: undefined as unknown as string,
          appSecret: undefined as unknown as string,
          serviceId: "placeholder-app",
          endpoint: collector.url,
          flushInterval: 1000,
          runtimeMetrics: false,
          forwardLogs: false,
        }),
      ],
      controllers: [PingController],
    })
    class PlaceholderModule {}

    app = await NestFactory.create(PlaceholderModule, {
      instrument: ObserveInstrument,
    });
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
    output?.restore();
    await collector?.close();
  });

  it("still sends, without the credential headers", async () => {
    const res = await fetch(`${baseUrl}/ping`, {
      headers: { "x-request-id": "unauthenticated-1" },
    });
    expect(res.status).toBe(200);
    await res.arrayBuffer();

    await collector.waitForTrace("unauthenticated-1");

    expect(collector.requests.length).toBeGreaterThan(0);
    for (const request of collector.requests) {
      expect(request.headers["x-api-key"]).toBeUndefined();
      expect(request.headers["x-api-secret"]).toBeUndefined();
    }
    expect(collector.violations).toEqual([]);
    expect(
      output.lines.filter((line) => line.includes("sends nothing")),
    ).toEqual([]);
  });
});
