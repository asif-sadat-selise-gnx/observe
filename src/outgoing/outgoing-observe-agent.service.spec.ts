import { AsyncLocalStorage } from "node:async_hooks";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/index.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { OutgoingObserveAgentService } from "./outgoing-observe-agent.service.js";

const nested = vi.hoisted(() => ({
  resolvedBy: [] as Array<[string, string]>,
  /** The `pg` copy npm nests inside Prisma's pg adapter on a version clash. */
  pg: {
    Client: class {
      query() {}
    },
    Pool: class {
      query() {}
    },
  },
}));

// No driver is the application's own here, so whatever gets patched is a
// copy found through a package that depends on the driver directly.
vi.mock("../utils/optional-peer.util.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../utils/optional-peer.util.js")>();
  const copies = new Map<string, unknown>([["@prisma/adapter-pg", nested.pg]]);
  return {
    ...original,
    loadOptionalPeer: () => ({ installed: false }),
    loadAsResolvedBy: (dependent: string, specifier: string) => {
      nested.resolvedBy.push([dependent, specifier]);
      return copies.get(dependent);
    },
  };
});

describe("OutgoingObserveAgentService", () => {
  it("patches the pg copy that Prisma's pg adapter resolves", () => {
    const storage = new AsyncLocalStorage<Map<any, any>>();
    const service = new OutgoingObserveAgentService(
      {
        outgoing: { http: false },
        traceIdKey: "traceId",
      } as ObserveModuleOptionsWithDefaults,
      new OperationTraceRegistry(storage, false),
      storage,
    );
    service.onApplicationShutdown();

    expect(nested.resolvedBy).toContainEqual(["@prisma/adapter-pg", "pg"]);
    for (const { prototype } of [nested.pg.Client, nested.pg.Pool]) {
      expect(
        Object.hasOwn(prototype, Symbol.for("nestjs.observe.original.query")),
      ).toBe(true);
    }
  });
});
