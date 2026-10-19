import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addDependencyCommand,
  detectPackageManager,
} from "./package-manager.js";

describe("detectPackageManager", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "observe-pm-"));
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "package.json"), "{}");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each([
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
  ])("reads %s as %s", (lockfile, manager) => {
    writeFileSync(join(root, lockfile), "");
    expect(detectPackageManager(root)).toBe(manager);
  });

  it("finds a workspace's lockfile at the repository's root", () => {
    const app = join(root, "apps", "orders");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "package.json"), "{}");
    writeFileSync(join(root, "yarn.lock"), "");

    expect(detectPackageManager(app)).toBe("yarn");
  });

  it("falls back to Corepack's packageManager field, then to npm", () => {
    expect(detectPackageManager(root)).toBe("npm");

    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ packageManager: "pnpm@9.12.0" }),
    );
    expect(detectPackageManager(root)).toBe("pnpm");
  });
});

describe("addDependencyCommand", () => {
  it("installs with npm and adds with the rest", () => {
    expect(addDependencyCommand("npm", "x@^1.0.0")).toEqual([
      "npm",
      ["install", "x@^1.0.0"],
    ]);
    expect(addDependencyCommand("yarn", "x@^1.0.0")).toEqual([
      "yarn",
      ["add", "x@^1.0.0"],
    ]);
  });
});
