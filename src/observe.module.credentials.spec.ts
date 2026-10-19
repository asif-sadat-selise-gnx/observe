import { FactoryProvider, ValueProvider } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ObserveOptions } from "./interfaces/observe-options.interface.js";
import { OBSERVE_OPTIONS } from "./observe.constants.js";
import { createObserveModule } from "./observe.module.js";

/**
 * The key pair from OBSERVE_APP_KEY / OBSERVE_APP_SECRET, for the project
 * `npx @nestjs/observe link` wrote a `.env` into: its AppModule still holds
 * the `nest new` placeholders, and `--env-file .env` puts the real pair in
 * the environment before AppModule is imported.
 */
describe("createObserveModule credentials from the environment", () => {
  const { ObserveModule } = createObserveModule();
  const envBefore = { ...process.env };

  const resolved = (options: Partial<ObserveOptions>) => {
    const provider = ObserveModule.forRoot(
      options as ObserveOptions,
    ).providers!.find(
      (candidate) => (candidate as ValueProvider).provide === OBSERVE_OPTIONS,
    ) as ValueProvider;
    return provider.useValue as ObserveOptions;
  };

  beforeEach(() => {
    process.env.OBSERVE_APP_KEY = "env-key";
    process.env.OBSERVE_APP_SECRET = "env-secret";
  });

  afterEach(() => {
    process.env = { ...envBefore };
  });

  it("replaces the nest new placeholders", () => {
    expect(
      resolved({
        appKey: "YOUR_APP_KEY",
        appSecret: "YOUR_APP_SECRET",
        serviceId: "svc",
      }),
    ).toMatchObject({ appKey: "env-key", appSecret: "env-secret" });
  });

  it("fills credentials the options leave out", () => {
    expect(resolved({ serviceId: "svc" })).toMatchObject({
      appKey: "env-key",
      appSecret: "env-secret",
    });
  });

  it("never overrides a pair the application passes", () => {
    expect(
      resolved({
        appKey: "own-key",
        appSecret: "own-secret",
        serviceId: "svc",
      }),
    ).toMatchObject({ appKey: "own-key", appSecret: "own-secret" });
  });

  it("keeps the placeholders when the environment has nothing", () => {
    // So the agent still says it is not connected yet, with the demo link.
    delete process.env.OBSERVE_APP_KEY;
    delete process.env.OBSERVE_APP_SECRET;

    expect(
      resolved({
        appKey: "YOUR_APP_KEY",
        appSecret: "YOUR_APP_SECRET",
        serviceId: "svc",
      }),
    ).toMatchObject({ appKey: "YOUR_APP_KEY", appSecret: "YOUR_APP_SECRET" });
  });

  it("applies to forRootAsync factories as well", async () => {
    const [provider] = ObserveModule.createAsyncProviders({
      useFactory: () => ({
        appKey: "YOUR_APP_KEY",
        appSecret: "YOUR_APP_SECRET",
        serviceId: "svc",
      }),
    });

    await expect(
      (provider as FactoryProvider).useFactory(),
    ).resolves.toMatchObject({ appKey: "env-key", appSecret: "env-secret" });
  });
});
