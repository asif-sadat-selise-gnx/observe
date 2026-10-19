const MAX_STATEMENT_LENGTH = 2048;
const MAX_IDENTIFIER_LENGTH = 64;

/**
 * Where each verb names the table it works on. `WITH` and anything unlisted
 * falls through to the verb alone - a wrong table is worse than none.
 */
const TABLE_AFTER: Record<string, RegExp> = {
  SELECT: /\bFROM\s+([\w."`[\]]+)/i,
  DELETE: /\bFROM\s+([\w."`[\]]+)/i,
  INSERT: /\bINTO\s+([\w."`[\]]+)/i,
  REPLACE: /\bINTO\s+([\w."`[\]]+)/i,
  UPDATE: /^\s*UPDATE\s+(?:ONLY\s+)?([\w."`[\]]+)/i,
};

export interface SqlStatementDescription {
  /**
   * A low-cardinality label: the verb and the table, `SELECT users`. It names
   * the span, so it is also what repeated queries collapse under and what the
   * per-method aggregates group by - one row per kind of query, not one per
   * distinct WHERE clause.
   */
  operation: string;
  /** The statement with every literal replaced, safe to leave the process. */
  statement: string;
}

/**
 * Comments, quoted identifiers, dollar-quoted bodies (Postgres) and strings,
 * matched in one left-to-right pass: a comment marker inside a string, or a
 * quote inside a comment or an identifier, is part of the token it is in.
 * Each runs to the end of the input when nothing closes it. A dollar quote
 * cannot open inside a word, where Postgres reads `$` as part of a name.
 * Strings take doubled-quote and backslash escapes. Identifiers are kept as
 * they are.
 */
const QUOTED_OR_COMMENT =
  /(\/\*[\s\S]*?(?:\*\/|$)|--[^\n]*)|("(?:[^"]|"")*(?:"|$)|`(?:[^`]|``)*(?:`|$))|(?<!\w)\$(?<tag>[A-Za-z_]*)\$[\s\S]*?(?:\$\k<tag>\$|$)|'(?:[^'\\]|\\[\s\S]?|'')*(?:'|$)/g;

/**
 * Strips a SQL statement of its values.
 *
 * Bound parameters never reach this function - only the text does - but
 * applications interpolate, and an interpolated statement carries its data in
 * its literals. Every string, number and IN-list is replaced, so what is
 * shipped is the statement's shape. Comments go too: ORMs and query taggers
 * put request ids and user ids in them.
 */
export function describeSqlStatement(sql: string): SqlStatementDescription {
  const input = sql.slice(0, MAX_STATEMENT_LENGTH * 4);
  let sanitized = input
    .replace(QUOTED_OR_COMMENT, (token, comment, identifier) =>
      comment !== undefined ? " " : identifier !== undefined ? token : "?",
    )
    // A number that is not part of an identifier or a `$1` placeholder.
    .replace(/(?<![\w$])-?\d+(?:\.\d+)?(?:e[+-]?\d+)?(?![\w])/gi, "?");
  if (sql.length > input.length) {
    // The bound may have cut a number short - `987654e+` is no longer one -
    // so whatever word it cut goes too. Anchored at the run's start, which
    // keeps it linear on a run 8 KB long.
    sanitized = sanitized.replace(
      /(^|[^\p{L}\p{M}\p{N}_$])[\p{L}\p{M}\p{N}_$]+[+-]?$/u,
      "$1?",
    );
  }
  const statement = sanitized
    .replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, "(?)")
    .replace(/\(\s*\$\d+(?:\s*,\s*\$\d+)+\s*\)/g, "($n)")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_STATEMENT_LENGTH);

  const verb = /^[\s(]*([A-Za-z]+)/.exec(statement)?.[1]?.toUpperCase();
  if (!verb) {
    return { operation: "QUERY", statement };
  }
  const table = TABLE_AFTER[verb]
    ?.exec(statement)?.[1]
    ?.replace(/["`[\]]/g, "")
    .slice(0, MAX_IDENTIFIER_LENGTH);
  return { operation: table ? `${verb} ${table}` : verb, statement };
}
