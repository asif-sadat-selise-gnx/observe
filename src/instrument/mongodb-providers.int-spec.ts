import { Controller, Inject, Module, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { Db, MongoClient } from "mongodb";
import { connect } from "net";
import request from "supertest";
import { CompleteTraceEventNode } from "../interfaces/trace-events.interfaces.js";
import { createObserveModule } from "../observe.module.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  testObserveOptions,
  waitForSnapshot,
} from "../testing/observe-harness.js";

const MONGO_HOST = process.env.MONGO_HOST ?? "127.0.0.1";
const MONGO_PORT = Number(process.env.MONGO_PORT ?? 27027);

const mongoReachable = await new Promise<boolean>((resolve) => {
  const socket = connect({ host: MONGO_HOST, port: MONGO_PORT });
  const finish = (up: boolean) => {
    socket.destroy();
    resolve(up);
  };
  socket.setTimeout(500, () => finish(false));
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
});

const { ObserveModule, ObserveInstrument } = createObserveModule();

const MONGO_CLIENT = "MONGO_CLIENT";
const MONGO_DB = "MONGO_DB";

@Controller()
class ItemsController {
  constructor(
    @Inject(MONGO_CLIENT) private readonly client: MongoClient,
    @Inject(MONGO_DB) private readonly db: Db,
  ) {}

  @Post("session")
  async withExplicitSession() {
    const session = this.client.startSession();
    try {
      return await this.db.collection("items").findOne({}, { session });
    } finally {
      await session.endSession();
    }
  }

  @Post("with-session")
  async withSession() {
    return this.client.withSession((session) =>
      this.db.collection("items").findOne({}, { session }),
    );
  }
}

@Module({
  imports: [ObserveModule.forRoot(testObserveOptions())],
  controllers: [ItemsController],
  providers: [
    {
      provide: MONGO_CLIENT,
      useFactory: () =>
        new MongoClient(`mongodb://${MONGO_HOST}:${MONGO_PORT}`, {
          serverSelectionTimeoutMS: 3000,
        }).connect(),
    },
    {
      // Made at bootstrap, outside any trace: the `Db` keeps whatever client
      // `db()` ran against.
      provide: MONGO_DB,
      useFactory: (client: MongoClient) => client.db("observe_int_providers"),
      inject: [MONGO_CLIENT],
    },
  ],
})
class MongoProvidersTestModule {}

const spansOf = (
  nodes: CompleteTraceEventNode[],
  className: string,
): CompleteTraceEventNode[] =>
  nodes.flatMap((node) => [
    ...(node.className === className ? [node] : []),
    ...spansOf(node.children ?? [], className),
  ]);

/**
 * A `MongoClient` and a `Db` registered as providers, the way most apps wire
 * the driver without an ODM.
 *
 * Proxied, they ran against the raw client outside a trace and against the
 * proxy inside one, so a `Db` made at bootstrap and a session started in a
 * traced request held different clients, and the driver rejected the session
 * with "ClientSession must be from the same MongoClient".
 */
describe.skipIf(!mongoReachable)(
  "ObserveModule: mongodb driver handles as providers",
  () => {
    let app: NestExpressApplication;
    let collected: CollectedSnapshots;

    beforeAll(async () => {
      app = await NestFactory.create<NestExpressApplication>(
        MongoProvidersTestModule,
        { instrument: ObserveInstrument, logger: false },
      );
      collected = collectSnapshots(app);
      await app.init();
    });

    afterAll(async () => {
      await app
        ?.get<Db>(MONGO_DB)
        .dropDatabase()
        .catch(() => undefined);
      await app
        ?.get<MongoClient>(MONGO_CLIENT)
        .close()
        .catch(() => undefined);
      await app?.close();
    });

    beforeEach(() => collected.clear());

    it.each(["/session", "/with-session"])(
      "runs a traced query on an explicit session (%s)",
      async (path) => {
        await request(app.getHttpServer()).post(path).expect(201);

        const snapshot = await waitForSnapshot(
          collected,
          (item) => item.operationId === path,
        );
        const traces = snapshot.traces as CompleteTraceEventNode[];
        expect(spansOf(traces, "ItemsController")).toHaveLength(1);
        // The command is still recorded, by the mongodb integration.
        expect(
          spansOf(traces, "mongodb").map(({ methodKey }) => methodKey),
        ).toEqual(["find items"]);
        // And the handles themselves add nothing.
        expect(spansOf(traces, "MongoClient")).toEqual([]);
        expect(spansOf(traces, "Db")).toEqual([]);
      },
    );
  },
);
