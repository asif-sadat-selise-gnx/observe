import { describeSqlStatement } from "./sql-statement.util.js";

describe("describeSqlStatement", () => {
  it.each([
    [
      `SELECT "u"."id" FROM "users" "u" WHERE "u"."email" = 'a@b.co' AND age > 21`,
      "SELECT users",
      `SELECT "u"."id" FROM "users" "u" WHERE "u"."email" = ? AND age > ?`,
    ],
    [
      "select * from orders where id in (1, 2, 3, 4)",
      "SELECT orders",
      "select * from orders where id in (?)",
    ],
    [
      "SELECT * FROM public.orders WHERE id = ANY($1) AND tenant IN ($2, $3, $4)",
      "SELECT public.orders",
      "SELECT * FROM public.orders WHERE id = ANY($1) AND tenant IN ($n)",
    ],
    [
      "INSERT INTO `audit_log` (actor, note) VALUES ('kamil', 'it''s done')",
      "INSERT audit_log",
      "INSERT INTO `audit_log` (actor, note) VALUES (?)",
    ],
    [
      "UPDATE accounts SET balance = balance - 10.50 WHERE id = 7",
      "UPDATE accounts",
      "UPDATE accounts SET balance = balance - ? WHERE id = ?",
    ],
    [
      "DELETE FROM sessions WHERE token = 'abc'",
      "DELETE sessions",
      "DELETE FROM sessions WHERE token = ?",
    ],
    ["BEGIN", "BEGIN", "BEGIN"],
    ["  ", "QUERY", ""],
  ])("%s", (sql, operation, statement) => {
    expect(describeSqlStatement(sql)).toEqual({ operation, statement });
  });

  it("drops comments, which is where taggers put request and user ids", () => {
    const { statement } = describeSqlStatement(
      "/* user:42 trace:abc */ SELECT 1 -- by kamil\nFROM dual",
    );
    expect(statement).toBe("SELECT ? FROM dual");
  });

  it("keeps digits that belong to identifiers", () => {
    expect(
      describeSqlStatement("SELECT col1 FROM table2 t0 WHERE t0.x = 5")
        .statement,
    ).toBe("SELECT col1 FROM table2 t0 WHERE t0.x = ?");
  });

  it("replaces a dollar-quoted body", () => {
    expect(
      describeSqlStatement("SELECT $tag$secret 'text'$tag$, $$other$$")
        .statement,
    ).toBe("SELECT ?, ?");
  });

  it("bounds what it ships", () => {
    const { statement } = describeSqlStatement(
      `SELECT ${"a, ".repeat(5000)} b FROM t`,
    );
    expect(statement.length).toBeLessThanOrEqual(2048);
  });

  // Only the first 8 KB is read, and a long comment or literal shrinks to
  // almost nothing: what the bound cut in two lands inside what is shipped.
  const comment = (length: number) => `/*${"x".repeat(length)}*/`;
  it.each([
    [`SELECT ${comment(8170)} 'secret-value' FROM t`, "SELECT ?"],
    [`SELECT ${comment(8172)} 'secret\\'s' FROM t`, "SELECT ?"],
    [`SELECT ${comment(8170)} $tag$secret body$tag$`, "SELECT ?"],
    [`SELECT ${comment(8170)} /* user:secret-value */`, "SELECT"],
    [`SELECT ${comment(8173)} 987654e2`, "SELECT ?"],
    [`SELECT ${comment(8172)} 987654e+2`, "SELECT ?"],
    [`SELECT ${comment(8172)} 987654e-2`, "SELECT ?"],
    [`SELECT ${comment(8170)} 98765.43e+2`, "SELECT ?.?"],
    [
      `INSERT INTO t (a, b) VALUES ('${"z".repeat(8150)}', 'secret-value')`,
      "INSERT INTO t (a, b) VALUES (?, ?",
    ],
  ])("ships no part of a value the input bound cuts: %#", (sql, statement) => {
    expect(describeSqlStatement(sql).statement).toBe(statement);
  });

  it.each([
    [
      "SELECT * FROM users WHERE pw = 'hunter2--x'\nAND id = 1",
      "SELECT * FROM users WHERE pw = ? AND id = ?",
    ],
    [
      "SELECT * FROM t WHERE a = 'secret-a$$b' AND b = $$secret-c$$",
      "SELECT * FROM t WHERE a = ? AND b = ?",
    ],
    [
      `SELECT "it's" FROM t WHERE name = 'secret-value'`,
      `SELECT "it's" FROM t WHERE name = ?`,
    ],
    [
      "SELECT `it's` FROM t WHERE name = 'secret-value'",
      "SELECT `it's` FROM t WHERE name = ?",
    ],
    [
      `SELECT "a--b" FROM t WHERE name = 'secret-value'`,
      `SELECT "a--b" FROM t WHERE name = ?`,
    ],
    [
      "SELECT * FROM t WHERE name = 'secret-value",
      "SELECT * FROM t WHERE name = ?",
    ],
  ])(
    "reads a quote or comment marker inside another token as part of it: %s",
    (sql, statement) => {
      expect(describeSqlStatement(sql).statement).toBe(statement);
    },
  );

  it("redacts a token cut by the input bound in linear time", () => {
    const sql = `SELECT ${"a".repeat(8180)} , secret_column FROM t`;
    const timings: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const startedAt = performance.now();
      describeSqlStatement(sql);
      timings.push(performance.now() - startedAt);
    }
    expect(Math.min(...timings)).toBeLessThan(50);
    expect(describeSqlStatement(sql).statement).toBe(
      `SELECT ${"a".repeat(2041)}`,
    );
  });
});
