import { Controller, Get, INestApplication, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createObserveModule } from "../observe.module.js";
import { CapturedOutput, captureOutput } from "../testing/observe-harness.js";

const { ObserveModule, ObserveInstrument } = createObserveModule();

@Controller()
class PingController {
  @Get("ping")
  ping() {
    return { ok: true };
  }
}

let output: CapturedOutput;

@Module({
  imports: [
    ObserveModule.forRoot({
      // What `appKey: process.env.OBSERVE_APP_KEY!` passes in a deployment
      // whose environment never reached the process.
      appKey: undefined as unknown as string,
      appSecret: undefined as unknown as string,
      serviceId: "unconfigured-app",
      // Named outright: the suites' global setup points the default endpoint
      // at a local sink, and this case is about the hosted collector.
      endpoint: "https://observe-api.nestjs.com",
      // Neither the flush timer nor the shutdown flush gets to run, so even an
      // agent that wrongly started its worker would send the real collector
      // nothing from this suite.
      flushInterval: 60_000,
      shutdownFlushTimeout: 0,
      runtimeMetrics: true,
      forwardLogs: false,
    }),
  ],
  controllers: [PingController],
})
class AppModule {}

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  output = captureOutput();

  app = await NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
  });
  await app.listen(0);
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app?.close();
  output?.restore();
});

/**
 * The hosted collector answers a batch without credentials with a 401, every
 * time, and every flush used to send one: 42% of the 1.87M batches it refused
 * on 2026-10-15 came from processes like this one, some of them for weeks.
 */
it("starts nothing against the hosted collector, and says why once", async () => {
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${baseUrl}/ping`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  }

  const notices = output.lines.filter((line) => line.includes("sends nothing"));
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("appKey and appSecret are not set");
  expect(notices[0]).toContain("https://observe.nestjs.com");

  // No thread was started to send anything.
  expect(
    output.lines.filter((line) =>
      line.includes("Observe agent worker initialized"),
    ),
  ).toEqual([]);
  // A warning, not an error: the application itself is fine.
  expect(output.lines.filter((line) => line.includes("Error:"))).toEqual([]);
});
