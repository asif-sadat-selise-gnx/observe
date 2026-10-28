import { join } from "node:path";
import {
  Controller,
  Get,
  INestApplication,
  INestMicroservice,
  Injectable,
  Module,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ApolloDriver, ApolloDriverConfig } from "@nestjs/apollo";
import { GraphQLModule, Query, Resolver } from "@nestjs/graphql";
import {
  ClientProxy,
  ClientProxyFactory,
  GrpcMethod,
  MessagePattern,
  Transport,
} from "@nestjs/microservices";
import {
  ExpressAdapter,
  NestExpressApplication,
} from "@nestjs/platform-express";
import { WsAdapter } from "@nestjs/platform-ws";
import { ScheduleModule, Timeout } from "@nestjs/schedule";
import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { credentials, loadPackageDefinition } from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { firstValueFrom } from "rxjs";
import request from "supertest";
import { WebSocket } from "ws";
import { createObserveModule } from "../observe.module.js";
import {
  CollectedJobSnapshots,
  CollectedSnapshots,
  collectJobSnapshots,
  collectSnapshots,
  freePort,
  testObserveOptions,
  waitFor,
  waitForSnapshot,
} from "../testing/observe-harness.js";

const PROTO_PATH = join(
  import.meta.dirname,
  "..",
  "testing",
  "orders.test.proto",
);
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const failing = (name: string) => (): never => {
  throw new Error(`${name} failed`);
};

/** How often each handler ran: once per call, whatever the callbacks did. */
const runs: Record<string, number> = {};
const ran = (handler: string) => {
  runs[handler] = (runs[handler] ?? 0) + 1;
};

/**
 * Long enough for a trace to be completed and shipped, which happens in a
 * timer after the reply - so an assertion that nothing was shipped is not
 * made before anything could have been.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

// Every module below runs with a generator that throws: it is the one callback
// set on the factory rather than in `forRoot`.
const { ObserveModule, ObserveInstrument } = createObserveModule({
  traceIdGenerator: failing("traceIdGenerator"),
});

@Controller()
class OrdersController {
  @Get("orders")
  list() {
    ran("http:orders");
    return [{ id: "42" }];
  }

  @Get("health")
  health() {
    ran("http:health");
    return { status: "ok" };
  }

  @Get("explode")
  explode(): never {
    ran("http:explode");
    throw new Error("deliberate");
  }
}

@Module({
  imports: [
    ObserveModule.forRoot(
      testObserveOptions({
        http: {
          setAttributes: failing("http.setAttributes"),
          // Throws for one route only, so the others show what is still
          // traced.
          ignore: (req: { url: string }) => {
            if (req.url === "/health") {
              throw new Error("http.ignore failed");
            }
            return false;
          },
        },
      }),
    ),
  ],
  controllers: [OrdersController],
})
class HttpCallbacksModule {}

@Resolver()
class OrdersResolver {
  @Query(() => String)
  order() {
    ran("graphql");
    return "order-42";
  }
}

@Module({
  imports: [
    ObserveModule.forRoot(
      testObserveOptions({
        graphql: {
          setAttributes: failing("graphql.setAttributes"),
          ignore: failing("graphql.ignore"),
        },
      }),
    ),
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
      playground: false,
    }),
  ],
  providers: [OrdersResolver],
})
class GraphqlCallbacksModule {}

@Controller()
class OrdersMessageController {
  @MessagePattern("orders.find")
  find(id: string) {
    ran("rpc:find");
    return { id };
  }

  @MessagePattern("orders.explode")
  explode(): never {
    ran("rpc:explode");
    throw new Error("deliberate");
  }
}

@Module({
  imports: [
    ObserveModule.forRoot(
      testObserveOptions({
        rpc: {
          setAttributes: failing("rpc.setAttributes"),
          ignore: failing("rpc.ignore"),
        },
      }),
    ),
  ],
  controllers: [OrdersMessageController],
})
class TcpCallbacksModule {}

@Controller()
class OrdersGrpcController {
  @GrpcMethod("Orders", "FindOne")
  findOne(data: { id: string }) {
    ran("grpc:find");
    return { id: data.id, name: `order-${data.id}` };
  }

  @GrpcMethod("Orders", "Explode")
  explode(): never {
    ran("grpc:explode");
    throw new Error("deliberate");
  }
}

@Module({
  imports: [
    ObserveModule.forRoot(
      testObserveOptions({
        grpc: {
          setAttributes: failing("grpc.setAttributes"),
          // Both decisions run in the timer the gRPC start defers to: this
          // one throws for one order, and the sampler for every call that
          // gets past it.
          ignore: (call: { request: { id: string } }) => {
            if (call.request.id === "ignored") {
              throw new Error("grpc.ignore failed");
            }
            return false;
          },
        },
        tracesSampleRate: failing("tracesSampleRate"),
      }),
    ),
  ],
  controllers: [OrdersGrpcController],
})
class GrpcCallbacksModule {}

@WebSocketGateway()
class OrdersGateway {
  @SubscribeMessage("order")
  order(@MessageBody() id: string) {
    ran("ws");
    return { event: "order", data: `order-${id}` };
  }
}

@Module({
  imports: [
    ObserveModule.forRoot(
      testObserveOptions({
        ws: {
          setAttributes: failing("ws.setAttributes"),
          ignore: failing("ws.ignore"),
        },
      }),
    ),
  ],
  providers: [OrdersGateway],
})
class WsCallbacksModule {}

@Injectable()
class OrdersJobs {
  @Timeout("reconcile", 20)
  reconcile() {
    ran("job");
  }
}

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ObserveModule.forRoot(
      testObserveOptions({
        jobs: {
          setAttributes: failing("jobs.setAttributes"),
          ignore: failing("jobs.ignore"),
        },
      }),
    ),
  ],
  providers: [OrdersJobs],
})
class JobsCallbacksModule {}

/**
 * Module options that throw, on every transport.
 *
 * `traceIdGenerator`, `setAttributes`, `ignore` and `tracesSampleRate` all
 * run before the handler does, so an exception from one used to stand in for
 * the handler's reply: a 500, a message that timed out, a socket that never
 * answered, or - from the timer gRPC defers its start to - an uncaught
 * exception that ended the process. Each now falls back, and the operation
 * runs as though it were not instrumented at all.
 */
describe("ObserveModule: user callbacks that throw", () => {
  // First: `@nestjs/schedule` is patched once per process, by the first app to
  // boot, and every scheduled handler runs through that app's options after.
  describe("scheduled jobs", () => {
    let app: INestApplication;
    let collected: CollectedJobSnapshots;

    beforeAll(async () => {
      app = await NestFactory.create(JobsCallbacksModule, {
        instrument: ObserveInstrument,
        logger: false,
      });
      collected = collectJobSnapshots(app);
      await app.init();
    });

    afterAll(async () => {
      await app?.close();
    });

    it("runs, without tracing, a job whose ignore predicate throws", async () => {
      await waitFor(() => runs["job"] === 1, 3000, "the scheduled job");
      await settle();

      expect(collected.items).toHaveLength(0);
    });
  });

  describe("HTTP", () => {
    let app: INestApplication;
    let collected: CollectedSnapshots;

    beforeAll(async () => {
      app = await NestFactory.create(
        HttpCallbacksModule,
        new ExpressAdapter(),
        { instrument: ObserveInstrument, logger: false },
      );
      collected = collectSnapshots(app);
      await app.init();
    });

    afterAll(async () => {
      await app?.close();
    });

    it("traces the request under a random id", async () => {
      await request(app.getHttpServer())
        .get("/orders")
        .expect(200, [{ id: "42" }]);

      const snapshot = await waitForSnapshot(
        collected,
        (item) => item.operationId === "/orders",
      );
      expect(snapshot.traceId).toMatch(UUID_V7);
      expect(runs["http:orders"]).toBe(1);
    });

    it("serves, without tracing, a request whose ignore predicate throws", async () => {
      await request(app.getHttpServer())
        .get("/health")
        .expect(200, { status: "ok" });
      await settle();

      expect(collected.find("/health")).toBeUndefined();
      expect(runs["http:health"]).toBe(1);
    });

    it("still answers 500 for a handler that throws", async () => {
      await request(app.getHttpServer()).get("/explode").expect(500);

      expect(runs["http:explode"]).toBe(1);
    });
  });

  describe("GraphQL", () => {
    let app: INestApplication;
    let collected: CollectedSnapshots;

    beforeAll(async () => {
      app = await NestFactory.create(
        GraphqlCallbacksModule,
        new ExpressAdapter(),
        { instrument: ObserveInstrument, logger: false },
      );
      collected = collectSnapshots(app);
      await app.init();
    });

    afterAll(async () => {
      await app?.close();
    });

    it("resolves, without tracing, an operation whose ignore predicate throws", async () => {
      await request(app.getHttpServer())
        .post("/graphql")
        .send({ query: "{ order }" })
        .expect(200, { data: { order: "order-42" } });
      await settle();

      expect(collected.items).toHaveLength(0);
      expect(runs["graphql"]).toBe(1);
    });
  });

  describe("TCP microservice", () => {
    let app: INestMicroservice;
    let collected: CollectedSnapshots;
    let client: ClientProxy;

    beforeAll(async () => {
      const port = await freePort();
      app = await NestFactory.createMicroservice(TcpCallbacksModule, {
        transport: Transport.TCP,
        options: { host: "127.0.0.1", port },
        instrument: ObserveInstrument,
        logger: false,
      } as never);
      collected = collectSnapshots(app);
      await app.listen();

      client = ClientProxyFactory.create({
        transport: Transport.TCP,
        options: { host: "127.0.0.1", port },
      });
      await client.connect();
    });

    afterAll(async () => {
      await client?.close();
      await app?.close();
    });

    it("replies, without tracing, to a message whose ignore predicate throws", async () => {
      await expect(
        firstValueFrom(client.send("orders.find", "42")),
      ).resolves.toEqual({ id: "42" });
      await settle();

      expect(collected.items).toHaveLength(0);
      expect(runs["rpc:find"]).toBe(1);
    });

    it("still rejects for a handler that throws", async () => {
      await expect(
        firstValueFrom(client.send("orders.explode", {})),
      ).rejects.toBeDefined();

      expect(runs["rpc:explode"]).toBe(1);
    });
  });

  describe("gRPC", () => {
    let app: INestMicroservice;
    let collected: CollectedSnapshots;
    let client: any;

    beforeAll(async () => {
      const port = await freePort();
      const url = `127.0.0.1:${port}`;
      app = await NestFactory.createMicroservice(GrpcCallbacksModule, {
        transport: Transport.GRPC,
        options: { package: "orderstest", protoPath: PROTO_PATH, url },
        instrument: ObserveInstrument,
        logger: false,
      } as never);
      collected = collectSnapshots(app);
      await app.listen();

      const definition = loadSync(PROTO_PATH, {
        keepCase: true,
        defaults: true,
        oneofs: true,
      });
      const proto = loadPackageDefinition(definition) as any;
      client = new proto.orderstest.Orders(url, credentials.createInsecure());
    });

    afterAll(async () => {
      client?.close?.();
      await app?.close();
    });

    const call = (method: string, payload: Record<string, unknown>) =>
      new Promise<any>((resolve, reject) => {
        client[method](payload, (error: unknown, response: unknown) =>
          error ? reject(error) : resolve(response),
        );
      });

    it("replies, without tracing, when ignore or the sampler throws", async () => {
      await expect(call("FindOne", { id: "ignored" })).resolves.toMatchObject({
        id: "ignored",
        name: "order-ignored",
      });
      await expect(call("FindOne", { id: "42" })).resolves.toMatchObject({
        id: "42",
        name: "order-42",
      });
      await settle();

      expect(collected.items).toHaveLength(0);
      expect(runs["grpc:find"]).toBe(2);
    });

    it("still fails the call for a handler that throws", async () => {
      await expect(call("Explode", { id: "9" })).rejects.toBeDefined();

      expect(runs["grpc:explode"]).toBe(1);
    });
  });

  describe("WebSocket", () => {
    let app: NestExpressApplication;
    let collected: CollectedSnapshots;
    let client: WebSocket;

    beforeAll(async () => {
      app = await NestFactory.create<NestExpressApplication>(
        WsCallbacksModule,
        { instrument: ObserveInstrument, logger: false },
      );
      app.useWebSocketAdapter(new WsAdapter(app));
      collected = collectSnapshots(app);
      const port = await freePort();
      await app.listen(port);

      client = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve, reject) => {
        client.once("open", resolve);
        client.once("error", reject);
      });
    });

    afterAll(async () => {
      client?.close();
      await app?.close();
    });

    it("replies, without tracing, to a message whose ignore predicate throws", async () => {
      const reply = new Promise<unknown>((resolve) => {
        client.once("message", (raw) => resolve(JSON.parse(String(raw))));
      });
      client.send(JSON.stringify({ event: "order", data: "42" }));

      expect(await reply).toEqual({ event: "order", data: "order-42" });
      await settle();

      expect(collected.items).toHaveLength(0);
      expect(runs["ws"]).toBe(1);
    });
  });
});
