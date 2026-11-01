// Whether the migrations after a baseline are additive, as 1.x migrations must be (ADR 0015): a
// Replica of the version before keeps running on the migrated store during a rolling update, so
// nothing it reads may go or change, and nothing it writes may start being refused.
//
// A list of what is allowed, not of what is forbidden, so that a statement nobody thought of is
// refused. It errs towards refusing: a person can read a refusal, and nothing reads a store's
// data back after a bad migration has run in production.

const TABLE = String.raw`(?:IF\s+NOT\s+EXISTS\s+)?("?\w+"?)`;
const CREATE_TABLE = new RegExp(String.raw`^CREATE\s+TABLE\s+${TABLE}\s*\(`, 'i');
const CREATE_INDEX = new RegExp(String.raw`^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?\w+"?\s+ON\s+("?\w+"?)\s*[(]`, 'i');
const ADD_COLUMN = /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?\w+"?\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(.+)$/is;
const ADDS_NO_COLUMN = /^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)\b/i;
const REFERENCES = /\bREFERENCES\s+("?\w+"?)/gi;

const bareName = (name: string) => name.replace(/"/g, '').toLowerCase();

/** The statements of `sql`, without comments. A `;` in a string or a quoted name does not end one. */
export function statementsOf(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      current += ' ';
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 1;
      current += ' ';
    } else if (c === "'" || c === '"') {
      const end = closingQuote(sql, i);
      current += sql.slice(i, end + 1);
      i = end;
    } else if (c === ';') {
      statements.push(current.trim());
      current = '';
    } else {
      current += c;
    }
  }
  statements.push(current.trim());
  return statements.filter((statement) => statement !== '');
}

function closingQuote(sql: string, open: number): number {
  const quote = sql[open]!;
  for (let i = open + 1; i < sql.length; i++) {
    if (sql[i] !== quote) continue;
    if (sql[i + 1] !== quote) return i;
    i++;
  }
  return sql.length;
}

/** The text with strings and what is in brackets taken out, to read its top level. */
function topLevel(text: string): string {
  let out = text.replace(/'(?:[^']|'')*'/g, "''");
  for (let before = ''; before !== out; ) {
    before = out;
    out = out.replace(/\([^()]*\)/g, '()');
  }
  return out;
}

/** Why adding this column could break a Replica of the version before, or null. */
function refusalOfColumn(definition: string): string | null {
  if (ADDS_NO_COLUMN.test(definition)) return 'adds a constraint to a table that exists, which can refuse what the version before writes';
  const level = topLevel(definition);
  if (level.includes(',')) return 'alters more than one thing in a statement: write one ADD COLUMN each';
  if (/\b(UNIQUE|CHECK|PRIMARY\s+KEY|REFERENCES|GENERATED)\b/i.test(level)) return 'adds a column with a constraint, which can refuse what the version before writes';
  if (/\bNOT\s+NULL\b/i.test(level) && !/\bDEFAULT\b/i.test(level)) return 'adds a NOT NULL column without a DEFAULT, so the version before cannot insert a row';
  return null;
}

/**
 * What is not additive in the migrations after the first `baseline`, each as
 * `v<number>: <why>: <statement>`. Empty means they are additive.
 */
export function nonAdditive(migrations: readonly string[], baseline: number): string[] {
  const problems: string[] = [];
  const newTables = new Set<string>();
  migrations.forEach((migration, index) => {
    if (index < baseline) return;
    for (const statement of statementsOf(migration)) {
      const why = refusalOf(statement, newTables);
      if (why) problems.push(`v${index + 1}: ${why}: ${statement.replace(/\s+/g, ' ')}`);
    }
  });
  return problems;
}

function refusalOf(statement: string, newTables: Set<string>): string | null {
  const table = CREATE_TABLE.exec(statement);
  if (table) {
    const name = bareName(table[1]!);
    const outside = [...statement.matchAll(REFERENCES)].map((m) => bareName(m[1]!)).find((target) => target !== name && !newTables.has(target));
    if (outside) return `references ${outside}, an older table, whose rows the version before could then no longer delete`;
    newTables.add(name);
    return null;
  }
  const index = CREATE_INDEX.exec(statement);
  if (index) {
    if (index[1] && !newTables.has(bareName(index[2]!))) return 'adds a unique index to an older table, which can refuse what the version before writes';
    return null;
  }
  const column = ADD_COLUMN.exec(statement);
  if (column) return refusalOfColumn(column[1]!);
  return 'is not CREATE TABLE, CREATE INDEX or ALTER TABLE ADD COLUMN';
}
