import { defineConfig } from "vitest/config";
import base from "./vitest.config.js";

const baseTest = base.test ?? {};

// The integration suites boot real Nest apps on real ports and leave the observe
// worker running, so they run one file at a time in a single process. `include`
// is replaced rather than merged - `mergeConfig` would concatenate it with the
// unit globs and run everything twice.
export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    include: ["src/**/*.int-spec.ts"],
    testTimeout: 30_000,
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
    // Keeps batches sent to the default endpoint on this machine - see the
    // file for why that matters now that the agent flushes on shutdown.
    globalSetup: ["./vitest.int.global-setup.ts"],
  },
});
