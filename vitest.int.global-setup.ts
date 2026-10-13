import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Gives the integration suites a collector that never leaves the machine.
 *
 * Most suites boot `ObserveModule` without an `endpoint`, which means the
 * hosted collector. They used to get away with it because nothing was sent
 * before the long flush interval came round - but the agent flushes on
 * shutdown, so every `app.close()` with a snapshot still buffered would post
 * test telemetry to production. `OBSERVE_ENDPOINT` is where the default comes
 * from; pointing it here keeps those batches local, and answering them
 * quietly keeps "could not reach the collector" lines out of suites that
 * assert on output. A suite that sets `endpoint` itself is unaffected, and an
 * `OBSERVE_ENDPOINT` already in the environment is left alone.
 */
export default async function setup(): Promise<() => Promise<void>> {
  if (process.env.OBSERVE_ENDPOINT) {
    return async () => {};
  }

  const sink = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve, reject) => {
    sink.once("error", reject);
    sink.listen(0, "127.0.0.1", resolve);
  });
  const { port } = sink.address() as AddressInfo;
  process.env.OBSERVE_ENDPOINT = `http://127.0.0.1:${port}`;

  return async () => {
    delete process.env.OBSERVE_ENDPOINT;
    sink.closeAllConnections();
    await new Promise((resolve) => sink.close(resolve));
  };
}
