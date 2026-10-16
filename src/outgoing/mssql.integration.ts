import { errorMonitor, EventEmitter } from "node:events";
import { OutgoingSpanRecorder } from "./outgoing-span.recorder.js";
import { patchMethod } from "./patch-method.util.js";
import { describeSanitizedSqlStatement } from "./sql-statement.util.js";

interface MssqlModule {
  Request?: { prototype?: object };
}

interface MssqlRequest extends EventEmitter {
  parent?: {
    config?: { options?: { enableQuotedIdentifier?: boolean | null } };
  };
}

function describeMssqlStatement(sql: string, enableQuotedIdentifier: boolean) {
  const input = sql.slice(0, 8192);
  let text = "";
  // T-SQL escapes quotes by doubling them, not with backslashes. Tokenizing
  // first keeps comment markers inside strings and identifiers inert.
  // Double quotes follow connection options; SQL SET overrides are not tracked.
  // Binary literals may continue across lines after a backslash.
  const tokenPattern =
    /(?<comment>--[^\r\n]*)|\[(?:[^\]]|\]\])*(?:\]|$)|(?<quoted>"(?:[^"]|"")*(?:"|$))|(?<literal>N?'(?:[^']|'')*(?:'|$)|(?<![\w@])\$\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)|\b0x[\da-f]*(?:\\(?:\r\n|\r|\n)[\da-f]*)*|(?<![\w$@])-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?![\w]))|[^]/giy;
  for (let index = 0; index < input.length; ) {
    if (input.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < input.length && depth) {
        if (input.startsWith("/*", index)) {
          depth++;
          index += 2;
        } else if (input.startsWith("*/", index)) {
          depth--;
          index += 2;
        } else {
          index++;
        }
      }
      text += " ";
      continue;
    }
    tokenPattern.lastIndex = index;
    const token = tokenPattern.exec(input)!;
    index = tokenPattern.lastIndex;
    if (token.groups?.comment !== undefined) {
      text += " ";
    } else if (
      token.groups?.literal !== undefined ||
      (!enableQuotedIdentifier && token.groups?.quoted !== undefined)
    ) {
      text += "?";
    } else {
      text += token[0];
    }
  }
  return describeSanitizedSqlStatement(text);
}

/**
 * These internal boundaries follow template expansion and precede pool
 * checkout. The tedious driver's `_batch` delegates to `_query`.
 */
export function patchMssql(
  mssql: MssqlModule,
  recorder: OutgoingSpanRecorder,
): boolean {
  const wrap = (method: string) => (original: (...args: any[]) => any) =>
    function (this: MssqlRequest, ...args: any[]) {
      const [command, callback] = args;
      if (typeof command !== "string" || typeof callback !== "function") {
        return original.apply(this, args);
      }
      const { operation, statement } = describeMssqlStatement(
        method === "_execute" ? `EXEC ${command}` : command,
        this.parent?.config?.options?.enableQuotedIdentifier !== false,
      );
      const span = recorder.open(
        "mssql",
        method === "_execute" ? statement.slice(0, 64) : operation,
        { "db.system": "mssql", "db.statement": statement },
      );
      if (!span) {
        return original.apply(this, args);
      }
      let streamError: unknown;
      const onError = (error: unknown) => {
        streamError ??= error;
      };
      // Observe streaming errors without swallowing unhandled error events.
      this.on(errorMonitor, onError);
      const finish = (error: unknown) => {
        this.removeListener(errorMonitor, onError);
        span.end(error ?? streamError);
      };
      args[1] = function (this: unknown, error: unknown, ...rest: any[]) {
        finish(error);
        return callback.call(this, error, ...rest);
      };
      try {
        return original.apply(this, args);
      } catch (error) {
        finish(error);
        throw error;
      }
    };

  const patched = ["_query", "_execute"].map((method) =>
    patchMethod(mssql.Request?.prototype, method, wrap(method)),
  );
  return patched.some(Boolean);
}
