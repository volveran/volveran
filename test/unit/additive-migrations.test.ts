// 1.x migrations only add (ADR 0015). The real migrations after the 1.0 baseline are checked in
// public-contracts.test.ts; here is what the check says about statements, worked by hand.
import { describe, expect, it } from 'vitest';
import { nonAdditive, statementsOf } from '../support/additive-migrations.js';

const OLD = 'CREATE TABLE old_table (id BIGINT); DROP TABLE older_table';
const after = (...sql: string[]) => nonAdditive([OLD, ...sql], 1);

describe('statementsOf', () => {
  it('splits on semicolons, not those in strings, quoted names or comments', () => {
    expect(statementsOf(`-- a; comment\nCREATE TABLE a (b TEXT DEFAULT ';');/* c; */\nCREATE TABLE "d;e" (f TEXT);`)).toEqual([
      `CREATE TABLE a (b TEXT DEFAULT ';')`,
      'CREATE TABLE "d;e" (f TEXT)',
    ]);
  });
});

describe('nonAdditive', () => {
  it('does not judge the migrations up to the baseline', () => {
    expect(nonAdditive([OLD], 1)).toEqual([]);
  });

  it.each([
    ['a new table', 'CREATE TABLE new_table (id BIGINT PRIMARY KEY, name TEXT NOT NULL UNIQUE)'],
    ['a new table, if not there', 'CREATE TABLE IF NOT EXISTS new_table (id BIGINT)'],
    ['an index', 'CREATE INDEX new_index ON old_table (id)'],
    ['a partial index', 'CREATE INDEX new_index ON old_table (id) WHERE id IS NOT NULL'],
    ['a nullable column', 'ALTER TABLE old_table ADD COLUMN note TEXT'],
    ['a column on PostgreSQL without the word COLUMN', 'ALTER TABLE old_table ADD note TEXT'],
    ['a NOT NULL column with a DEFAULT', "ALTER TABLE old_table ADD COLUMN note TEXT NOT NULL DEFAULT ''"],
    ['several, with comments', "-- first\nALTER TABLE old_table ADD COLUMN a BIGINT;\n/* then */ CREATE INDEX i ON old_table (a);"],
  ])('allows %s', (_, sql) => {
    expect(after(sql)).toEqual([]);
  });

  it.each([
    ['dropping a table', 'DROP TABLE old_table'],
    ['dropping an index', 'DROP INDEX old_index'],
    ['dropping a column', 'ALTER TABLE old_table DROP COLUMN name'],
    ['renaming a table', 'ALTER TABLE old_table RENAME TO other'],
    ['renaming a column', 'ALTER TABLE old_table RENAME COLUMN a TO b'],
    ['changing a type', 'ALTER TABLE old_table ALTER COLUMN a TYPE TEXT'],
    ['making a column NOT NULL', 'ALTER TABLE old_table ALTER COLUMN a SET NOT NULL'],
    ['deleting rows', 'DELETE FROM old_table'],
    ['changing rows', "UPDATE old_table SET a = 'b'"],
    ['emptying a table', 'TRUNCATE old_table'],
    ['a trigger', 'CREATE TRIGGER t BEFORE INSERT ON old_table EXECUTE FUNCTION f()'],
    ['a NOT NULL column without a DEFAULT', 'ALTER TABLE old_table ADD COLUMN a TEXT NOT NULL'],
    ['a NOT NULL column whose only DEFAULT is in a string', "ALTER TABLE old_table ADD COLUMN a TEXT NOT NULL COLLATE 'DEFAULT'"],
    ['a constraint', 'ALTER TABLE old_table ADD CONSTRAINT c CHECK (a > 0)'],
    ['a unique constraint', 'ALTER TABLE old_table ADD UNIQUE (a)'],
    ['a column with a check', 'ALTER TABLE old_table ADD COLUMN a BIGINT CHECK (a > 0)'],
    ['a column with a unique rule', 'ALTER TABLE old_table ADD COLUMN a BIGINT UNIQUE'],
    ['a column and something else in one statement', 'ALTER TABLE old_table ADD COLUMN a BIGINT, DROP COLUMN b'],
    ['a unique index on an older table', 'CREATE UNIQUE INDEX i ON old_table (a)'],
    ['a new table with a foreign key to an older one', 'CREATE TABLE new_table (id BIGINT REFERENCES old_table (id))'],
    ['changing a setting', 'PRAGMA foreign_keys = OFF'],
  ])('refuses %s', (_, sql) => {
    const problems = after(sql);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^v2: /);
  });

  it('allows what is new to the 1.x migrations to rely on what they themselves added', () => {
    expect(after('CREATE TABLE a (id BIGINT PRIMARY KEY)', 'CREATE TABLE b (a_id BIGINT REFERENCES a (id)); CREATE UNIQUE INDEX i ON b (a_id)')).toEqual([]);
  });

  it('finds the one bad statement among good ones, and names its migration', () => {
    const problems = after('CREATE TABLE a (id BIGINT)', 'CREATE INDEX i ON a (id); DROP TABLE old_table');
    expect(problems).toEqual(['v3: is not CREATE TABLE, CREATE INDEX or ALTER TABLE ADD COLUMN: DROP TABLE old_table']);
  });
});
