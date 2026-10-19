import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findEntryFiles, serviceIdFor } from "./project-setup.js";

describe("serviceIdFor", () => {
  it("turns the application's name into an id the way the dashboard does", () => {
    expect(serviceIdFor("Orders API")).toBe("orders-api");
    expect(serviceIdFor("billing_worker 2")).toBe("billingworker-2");
  });

  it("falls back to the package's name, without its scope", () => {
    expect(serviceIdFor("___", "@acme/orders-api")).toBe("orders-api");
    expect(serviceIdFor(undefined, undefined)).toBe("app");
  });
});

describe("findEntryFiles", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "observe-entry-"));
  });

  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const touch = (path: string, text = "") => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };

  it("finds src/main.ts without a nest-cli.json", () => {
    touch("src/main.ts");
    expect(findEntryFiles(cwd, ts)).toEqual(["src/main.ts"]);
  });

  it("reads a nest-cli.json with comments, and skips libraries", () => {
    touch(
      "nest-cli.json",
      `{
        // The default project.
        "sourceRoot": "apps/orders/src",
        "projects": {
          "orders": { "type": "application", "root": "apps/orders" },
          "shared": { "type": "library", "root": "libs/shared" },
        },
      }`,
    );
    touch("apps/orders/src/main.ts");
    touch("libs/shared/src/main.ts");

    expect(findEntryFiles(cwd, ts)).toEqual(["apps/orders/src/main.ts"]);
  });
});
