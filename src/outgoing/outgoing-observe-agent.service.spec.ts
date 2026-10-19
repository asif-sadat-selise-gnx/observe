import { AsyncLocalStorage } from "node:async_hooks";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/index.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { OutgoingObserveAgentService } from "./outgoing-observe-agent.service.js";

const nested = vi.hoisted(() => ({
  resolvedBy: [] as Array<[string, string]>,
  /** The `mssql` copy npm nests inside Prisma's adapter on a version clash. */
  Request: class {
    _query() {}
    _execute() {}
  },
}));

// No driver is the application's own here, so whatever gets patched is a
// copy found through a package that depends on the driver directly.
vi.mock("../utils/optional-peer.util.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../utils/optional-peer.util.js")>();
  return {
    ...original,
    loadOptionalPeer: () => ({ installed: false }),
    loadAsResolvedBy: (dependent: string, specifier: string) => {
      nested.resolvedBy.push([dependent, specifier]);
      return dependent === "@prisma/adapter-mssql"
        ? { Request: nested.Request }
        : undefined;
    },
  };
});

describe("OutgoingObserveAgentService", () => {
  it("patches the mssql copy that Prisma's SQL Server adapter resolves", () => {
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

    expect(nested.resolvedBy).toContainEqual([
      "@prisma/adapter-mssql",
      "mssql",
    ]);
    for (const method of ["_query", "_execute"]) {
      expect(
        Object.hasOwn(
          nested.Request.prototype,
          Symbol.for(`nestjs.observe.original.${method}`),
        ),
      ).toBe(true);
    }
  });
});
