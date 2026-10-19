import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** Lockfiles, in the order they are looked for in each directory. */
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

const MANAGERS = new Set<string>(["npm", "pnpm", "yarn", "bun"]);

/**
 * The package manager the project is installed with.
 *
 * The nearest lockfile decides, looked for from `cwd` up to the repository's
 * root - a package inside a workspace has its lockfile at the root. Without
 * one, Corepack's `packageManager` field in package.json does, and npm is
 * the answer when neither says anything. Running `npx` says nothing either
 * way: it is how the command was started, not how the project installs.
 */
export function detectPackageManager(cwd: string): PackageManager {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const found = LOCKFILES.find(([file]) => existsSync(join(dir, file)));
    if (found) {
      return found[1];
    }
    // The repository's root is as far as the project goes: a lockfile
    // above it belongs to something else.
    if (existsSync(join(dir, ".git")) || dirname(dir) === dir) {
      break;
    }
  }
  return declaredPackageManager(cwd) ?? "npm";
}

/** `"pnpm@9.12.0"` in package.json's `packageManager` field, as `"pnpm"`. */
function declaredPackageManager(cwd: string): PackageManager | undefined {
  try {
    const { packageManager } = JSON.parse(
      readFileSync(join(cwd, "package.json"), "utf8"),
    ) as { packageManager?: unknown };
    const name =
      typeof packageManager === "string"
        ? packageManager.split("@")[0]
        : undefined;
    return name && MANAGERS.has(name) ? (name as PackageManager) : undefined;
  } catch {
    return undefined;
  }
}

/** The command that adds `spec` to the project's dependencies. */
export function addDependencyCommand(
  manager: PackageManager,
  spec: string,
): [command: string, args: string[]] {
  return manager === "npm"
    ? ["npm", ["install", spec]]
    : [manager, ["add", spec]];
}
