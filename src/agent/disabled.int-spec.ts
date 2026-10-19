import {
  Controller,
  Get,
  INestApplication,
  Injectable,
  Module,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createObserveModule } from "../observe.module.js";
import { TracerService } from "../services/tracer.service.js";
import {
  CapturedOutput,
  captureOutput,
  CollectedSnapshots,
  collectSnapshots,
} from "../testing/observe-harness.js";

const { ObserveModule, ObserveInstrument } = createObserveModule();

@Injectable()
class OrdersService {
  findAll() {
    return [{ id: 1 }];
  }
}

@Controller()
class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly tracer: TracerService,
  ) {}

  // Everything application code may call on the tracer, to show that none of
  // it throws, or warns, when the agent is switched off.
  @Get("orders")
  async findAll() {
    const orders = await this.tracer.createSpan("load", () =>
      this.orders.findAll(),
    );
    (await this.tracer.activeSpan()).setTag("count", 1);
    await this.tracer.captureError(new Error("handled"));
    this.tracer.counter("orders_listed").increment();
    return orders;
  }
}

@Module({
  imports: [
    ObserveModule.forRoot({
      enabled: false,
      // What `process.env.OBSERVE_APP_KEY ?? ""` passes in local development,
      // against the hosted collector: the case that otherwise warns.
      appKey: "",
      appSecret: "",
      serviceId: "disabled-app",
      endpoint: "https://observe-api.nestjs.com",
      flushInterval: 60_000,
      shutdownFlushTimeout: 0,
      runtimeMetrics: true,
      forwardLogs: true,
    }),
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
})
class AppModule {}

let app: INestApplication;
let baseUrl: string;
let output: CapturedOutput;
let snapshots: CollectedSnapshots;

beforeAll(async () => {
  output = captureOutput();

  app = await NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
  });
  snapshots = collectSnapshots(app);
  await app.listen(0);
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app?.close();
  output?.restore();
});

it("serves requests while recording and sending nothing, and says so once", async () => {
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${baseUrl}/orders`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 1 }]);
  }
  // Long enough for a trace that had been opened to complete and land.
  await new Promise((resolve) => setTimeout(resolve, 100));

  expect(snapshots.items).toEqual([]);

  const notices = output.lines.filter((line) =>
    line.includes("Observe is disabled"),
  );
  expect(notices).toHaveLength(1);

  // No warning about the missing credentials, nor about errors captured
  // without a trace.
  expect(output.lines.filter((line) => line.includes("WARN"))).toEqual([]);
  expect(output.lines.filter((line) => line.includes("Error:"))).toEqual([]);
  expect(
    output.lines.filter((line) =>
      line.includes("Observe agent worker initialized"),
    ),
  ).toEqual([]);
});
