import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readSdkVersion } from "./sdk-version.util.js";

describe("readSdkVersion", () => {
  it("reads this package's own version", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(readSdkVersion()).toBe(manifest.version);
  });
});
