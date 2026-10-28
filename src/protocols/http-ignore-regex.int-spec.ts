import {
  Controller,
  Get,
  INestApplication,
  Module,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import request from "supertest";
import type { ObserveOptions } from "../interfaces/observe-options.interface.js";
import { createObserveModule } from "../observe.module.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  testObserveOptions,
  waitForSnapshot,
} from "../testing/observe-harness.js";

@Controller()
class HealthController {
  @Get("health")
  health() {
    return { ok: true };
  }

  @Get("ordinary")
  ordinary() {
    return { ok: true };
  }
}

const ignoreScenarios = [
  ["global direct regex", () => [/^\/health$/g]],
  ["sticky direct regex", () => [/^\/health$/y]],
  [
    "global method-scoped regex",
    () => [{ method: "GET", path: /^\/health$/g }],
  ],
  [
    "sticky method-scoped regex",
    () => [{ method: "GET", path: /^\/health$/y }],
  ],
] as const;

async function bootApp(
  ignore: NonNullable<ObserveOptions["http"]>["ignore"],
): Promise<{
  app: INestApplication;
  collected: CollectedSnapshots;
}> {
  const { ObserveModule, ObserveInstrument } = createObserveModule();
  class HttpIgnoreTestModule {}
  Module({
    imports: [
      ObserveModule.forRoot(testObserveOptions({ http: { ignore } })),
    ],
    controllers: [HealthController],
  })(HttpIgnoreTestModule);

  const app = await NestFactory.create(
    HttpIgnoreTestModule,
    new ExpressAdapter(),
    { instrument: ObserveInstrument, logger: false },
  );
  const collected = collectSnapshots(app);
  await app.init();
  return { app, collected };
}

describe("ObserveModule: HTTP ignore regex state", () => {
  it.each(ignoreScenarios)(
    "always excludes repeated /health requests with a %s",
    async (_name, makeIgnore) => {
      const { app, collected } = await bootApp(makeIgnore());
      try {
        for (let index = 0; index < 6; index++) {
          await request(app.getHttpServer()).get("/health").expect(200);
        }
        await request(app.getHttpServer()).get("/ordinary").expect(200);

        await waitForSnapshot(
          collected,
          (snapshot) => snapshot.operationId === "/ordinary",
        );

        expect(collected.items.map((snapshot) => snapshot.operationId)).toEqual([
          "/ordinary",
        ]);
      } finally {
        await app.close();
      }
    },
  );
});
