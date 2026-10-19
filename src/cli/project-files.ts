import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The variables `ObserveModule` falls back to for its key pair. */
export const KEY_VARIABLE = "OBSERVE_APP_KEY";
export const SECRET_VARIABLE = "OBSERVE_APP_SECRET";

/** The scripts that get `--env-file .env`, when they run `nest start`. */
const START_SCRIPTS = ["start", "start:dev"] as const;

/**
 * Writes the key pair into `<cwd>/.env`, replacing an earlier pair and keeping
 * every other line as it was. Created owner-only when it does not exist.
 *
 * Both values are single-quoted. Key and secret are drawn from the same
 * alphabet, which includes `$` and `&`: unquoted, a loader that expands
 * variables (`dotenv-expand`, `ConfigModule` with `expandVariables`) rewrites
 * everything after a `$`, and a shell sourcing the file stops at the `&`.
 * Node's own `--env-file` reads either form literally. Single quotes are
 * literal in all of them, and the alphabet has no quote in it to escape.
 */
export function writeEnvFile(cwd: string, appKey: string, appSecret: string) {
  const path = join(cwd, ".env");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const kept = existing
    .split(/\r?\n/)
    .filter(
      (line) =>
        !new RegExp(
          `^\\s*(export\\s+)?(${KEY_VARIABLE}|${SECRET_VARIABLE})\\s*=`,
        ).test(line),
    );
  while (kept.length && kept[kept.length - 1].trim() === "") {
    kept.pop();
  }
  const lines = [
    ...kept,
    ...(kept.length ? [""] : []),
    `${KEY_VARIABLE}='${appKey}'`,
    `${SECRET_VARIABLE}='${appSecret}'`,
    "",
  ];
  writeFileSync(path, lines.join("\n"), existing ? undefined : { mode: 0o600 });
  return path;
}

/**
 * Makes sure `.env` is git-ignored, so the secret cannot be committed by
 * accident. `nest new` already ignores it; a project from elsewhere may not.
 * Returns whether the file had to be changed.
 */
export function ensureEnvIgnored(cwd: string): boolean {
  const path = join(cwd, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const ignored = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === ".env" || line === "/.env" || line === ".env*");
  if (ignored) {
    return false;
  }
  const separator = existing && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(
    path,
    `${existing}${separator}\n# NestJS Observe key pair\n.env\n`,
  );
  return true;
}

export interface ScriptsUpdate {
  /** Scripts that now load `.env`. */
  updated: string[];
  /** Start scripts that exist but do not run `nest start`, left alone. */
  skipped: string[];
}

/**
 * Adds `--env-file .env` to the `start` and `start:dev` scripts that run
 * `nest start`, so the pair in `.env` reaches the process. Scripts that
 * already pass an env file, or start the app some other way, are left as
 * they are - and reported, so the caller can say how to load the file.
 */
export function addEnvFileToStartScripts(cwd: string): ScriptsUpdate {
  const path = join(cwd, "package.json");
  const raw = readFileSync(path, "utf8");
  const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
  const result: ScriptsUpdate = { updated: [], skipped: [] };

  for (const name of START_SCRIPTS) {
    const script = pkg.scripts?.[name];
    if (script === undefined) {
      continue;
    }
    if (/--env-file\b/.test(script)) {
      continue;
    }
    if (!/^\s*nest start\b/.test(script)) {
      result.skipped.push(name);
      continue;
    }
    pkg.scripts![name] = `${script.trimEnd()} --env-file .env`;
    result.updated.push(name);
  }

  if (result.updated.length) {
    const indent = raw.match(/^[ \t]+(?=")/m)?.[0] ?? "  ";
    writeFileSync(
      path,
      JSON.stringify(pkg, null, indent) + (raw.endsWith("\n") ? "\n" : ""),
    );
  }
  return result;
}

/** The project's package name, which the link proposes as the app's name. */
export function readPackageName(cwd: string): string | undefined {
  const path = join(cwd, "package.json");
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const name = (JSON.parse(readFileSync(path, "utf8")) as { name?: unknown })
      .name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}
