import { createRequire } from "module";

/**
 * What `x-observe-sdk-version` carries when this package's own manifest cannot
 * be read.
 */
export const UNKNOWN_SDK_VERSION = "unknown";

/**
 * This package's own version, as its installed `package.json` states it.
 *
 * Sent with every batch so the collector knows which agent an application
 * runs - nothing else tells it, and a project scaffolded with `^0.1.8` keeps
 * installing 0.1.x for as long as nobody edits that range.
 *
 * Resolved by the package's name rather than a relative path, and checked by
 * name: a bundle that moved this file would otherwise read the application's
 * own manifest and report its version instead. A bundle that erased
 * `import.meta.url`, or one shipped without `node_modules`, gets
 * {@link UNKNOWN_SDK_VERSION} - never an exception at start-up.
 */
export function readSdkVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const manifest = require("@nestjs/observe/package.json") as {
      name?: unknown;
      version?: unknown;
    };
    if (
      manifest.name === "@nestjs/observe" &&
      typeof manifest.version === "string" &&
      manifest.version.length > 0
    ) {
      return manifest.version;
    }
  } catch {
    // Falls through to the placeholder below.
  }
  return UNKNOWN_SDK_VERSION;
}
