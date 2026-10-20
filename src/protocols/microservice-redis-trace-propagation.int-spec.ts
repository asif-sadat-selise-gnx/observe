import {
  Controller,
  Get,
  Inject,
  INestApplication,
  INestMicroservice,
  Module,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ClientProxy,
  ClientsModule,
  EventPattern,
  MessagePattern,
  Payload,
  Transport,
} from "@nestjs/microservices";
import { connect } from "node:net";
import { firstValueFrom } from "rxjs";
import request from "supertest";
import { createObserveModule } from "../observe.module.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  testObserveOptions,
  waitForSnapshot,
} from "../testing/observe-harness.js";

const REDIS_HOST = process.env.REDIS_HOST ?? "127.0.0.1";
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);

/** The Redis transport has no in-memory driver, so this runs only where Redis answers. */
const redisReachable = await new Promise<boolean>((resolve) => {
  const socket = connect({ host: REDIS_HOST, port: REDIS_PORT });
  const finish = (reachable: boolean) => {
    socket.destroy();
    resolve(reachable);
  };
  socket.setTimeout(500, () => finish(false));
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
});

const UUID = /^[0-9a-f-]{36}$/;

/** See the TCP suite: the right outcome depends on what the framework can carry. */
const frameworkCarriesMetadata =
  typeof (ClientProxy.prototype as { setOnDispatchHook?: unknown })
    .setOnDispatchHook === "function";

// Redis channels are shared by everything on the server, so the patterns are
// this process's own.
const SUM = `observe-sum-${process.pid}`;
const AUDITED = `observe-audited-${process.pid}`;

const api = createObserveModule();
const math = createObserveModule();

@Controller()
class MathController {
  @MessagePattern(SUM)
  sum(@Payload() data: number[]) {
    return data.reduce((total, value) => total + value, 0);
  }

  @EventPattern(AUDITED)
  audited(_event: unknown) {
    // fire-and-forget
  }
}

@Module({
  imports: [math.ObserveModule.forRoot(testObserveOptions())],
  controllers: [MathController],
})
class MathModule {}

@Controller()
class ApiController {
  constructor(@Inject("MATH") private readonly client: ClientProxy) {}

  @Get("total")
  async total() {
    return { total: await firstValueFrom(this.client.send(SUM, [1, 2, 3])) };
  }

  @Get("audit")
  async audit() {
    await firstValueFrom(this.client.emit(AUDITED, { id: 1 }), {
      defaultValue: undefined,
    });
    return { ok: true };
  }
}

@Module({
  imports: [
    api.ObserveModule.forRoot(testObserveOptions()),
    ClientsModule.register([
      {
        name: "MATH",
        transport: Transport.REDIS,
        options: { host: REDIS_HOST, port: REDIS_PORT },
      },
    ]),
  ],
  controllers: [ApiController],
})
class ApiModule {}

/**
 * The Redis counterpart of the TCP suite: the other transport whose packets
 * carry metadata, from `@nestjs/microservices` 12.0.4 on.
 */
describe.skipIf(!redisReachable)(
  "ObserveModule: a trace from HTTP into a microservice over Redis",
  () => {
    let apiApp: INestApplication;
    let mathApp: INestMicroservice;
    let apiSnapshots: CollectedSnapshots;
    let mathSnapshots: CollectedSnapshots;

    beforeAll(async () => {
      mathApp = await NestFactory.createMicroservice(MathModule, {
        transport: Transport.REDIS,
        options: { host: REDIS_HOST, port: REDIS_PORT },
        instrument: math.ObserveInstrument,
        logger: false,
      } as never);
      mathSnapshots = collectSnapshots(mathApp);
      await mathApp.listen();

      apiApp = await NestFactory.create(ApiModule, {
        instrument: api.ObserveInstrument,
        logger: false,
      });
      apiSnapshots = collectSnapshots(apiApp);
      await apiApp.init();
    });

    afterAll(async () => {
      await apiApp?.close();
      await mathApp?.close();
    });

    beforeEach(() => {
      apiSnapshots.clear();
      mathSnapshots.clear();
    });

    it("completes the call through an instrumented ClientProxy, and both sides report", async () => {
      const response = await request(apiApp.getHttpServer())
        .get("/total")
        .expect(200);

      expect(response.body).toEqual({ total: 6 });
      // Both awaited, so neither lands in the next test after its `clear()`.
      const http = await waitForSnapshot(
        apiSnapshots,
        (item) => item.operationId === "/total",
      );
      const rpc = await waitForSnapshot(
        mathSnapshots,
        (item) => item.operationId === SUM,
      );
      expect(http.error).toBeUndefined();
      expect(rpc.protocol).toBe("REDIS");
      expect(rpc.error).toBeUndefined();
    });

    it.runIf(frameworkCarriesMetadata)(
      "runs the handler under the trace id the caller minted, where the framework carries packet metadata",
      async () => {
        await request(apiApp.getHttpServer()).get("/total").expect(200);

        const http = await waitForSnapshot(
          apiSnapshots,
          (item) => item.operationId === "/total",
        );
        const rpc = await waitForSnapshot(
          mathSnapshots,
          (item) => item.operationId === SUM,
        );
        expect(http.traceId).toMatch(UUID);
        expect(rpc.traceId).toBe(http.traceId);
      },
    );

    it.runIf(frameworkCarriesMetadata)(
      "runs an event handler under the caller's trace id too",
      async () => {
        await request(apiApp.getHttpServer())
          .get("/audit")
          .set("x-request-id", "redis-event-trace-1")
          .expect(200);

        const event = await waitForSnapshot(
          mathSnapshots,
          (item) => item.operationId === AUDITED,
        );
        expect(event.traceId).toBe("redis-event-trace-1");
      },
    );

    it.runIf(!frameworkCarriesMetadata)(
      "mints the handler an id of its own where the framework has no packet metadata",
      async () => {
        await request(apiApp.getHttpServer())
          .get("/total")
          .set("x-request-id", "redis-hop-trace-1")
          .expect(200);

        const rpc = await waitForSnapshot(
          mathSnapshots,
          (item) => item.operationId === SUM,
        );
        expect(rpc.traceId).toMatch(UUID);
        expect(rpc.traceId).not.toBe("redis-hop-trace-1");
      },
    );
  },
);
