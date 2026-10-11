import { fallbackOperationId } from "./fallback-operation-id.util.js";

const PROJECT = "b0c013f1-5ebc-444f-8f40-6c0ea68150e9";

/**
 * The collector folds what older agents send with the same rules, so these
 * cases mirror its spec: a difference between the two would split one route
 * in two while a fleet runs both agent versions.
 */
describe("fallbackOperationId", () => {
  it("folds a URL to its path, ids replaced", () => {
    expect(
      fallbackOperationId(
        `/me/projects/${PROJECT}/telemetry/dashboard?timeInterval=30d`,
      ),
    ).toBe("/me/projects/:id/telemetry/dashboard");
  });

  it("gives every query string of one path the same id", () => {
    const a = `/me/projects/${PROJECT}/telemetry/requests?timeInterval=custom&from=2026-10-01T00:00:00Z`;
    const b = `/me/projects/${PROJECT.toUpperCase()}/telemetry/requests?timeInterval=1h`;

    expect(fallbackOperationId(a)).toBe(fallbackOperationId(b));
  });

  it("folds every id segment, including the last", () => {
    expect(
      fallbackOperationId(`/me/projects/${PROJECT}/alerts/${PROJECT}`),
    ).toBe("/me/projects/:id/alerts/:id");
  });

  it("leaves a segment that only contains an id, and numeric segments", () => {
    expect(fallbackOperationId(`/files/${PROJECT}.json`)).toBe(
      `/files/${PROJECT}.json`,
    );
    expect(fallbackOperationId("/reports/2024")).toBe("/reports/2024");
  });

  it("leaves anything that is not a path alone", () => {
    const document = 'query { search(q: "why?") { id } }';

    expect(fallbackOperationId(document)).toBe(document);
    expect(fallbackOperationId(undefined)).toBeUndefined();
  });

  it("is settled after one fold", () => {
    // The collector folds again whenever the id still equals the URL - a path
    // with nothing to fold - so a second fold must never change it further.
    for (const url of [
      `/me/projects/${PROJECT}/telemetry/dashboard?timeInterval=30d`,
      `/files/${PROJECT}.json`,
      "/health",
      "/?ref=home",
    ]) {
      const folded = fallbackOperationId(url);
      expect(fallbackOperationId(folded)).toBe(folded);
    }
  });
});
