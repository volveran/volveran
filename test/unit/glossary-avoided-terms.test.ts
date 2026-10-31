// The `_Avoid_:` terms of GLOSSARY.md stay out of src/ prose: comments and
// strings of more than one word, which is what an Operator or the next reader
// sees. Identifiers, one-word strings (mostly keys and codes), SQL and `code
// spans` do not count. Many of the terms are everyday words that are only wrong
// for the concept the glossary names; `exceptions` says where one is fine and why.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// TypeScript 7 at the root has no compiler API; the lint package's TypeScript 6 does.
const ts = createRequire(path.join(root, 'tools/lint/'))('typescript');

interface Exception {
  term: string;
  /** Only in these files, relative to src/; without it, everywhere. */
  files?: string[];
  reason: string;
}

const exceptions: Exception[] = [
  {
    term: 'session',
    files: ['server/audit/postgres-migrations.ts', 'server/auth.ts', 'server/metrics/listener.ts', 'server/operator-token.ts', 'server/operator.ts', 'server/routes/health.ts', 'server/routes/session.ts', 'server/run-mode.ts', 'server/server.ts', 'shared/queues.ts', 'web/api.ts'],
    reason: 'Sign-in sessions in Team Mode and PostgreSQL sessions; the glossary means a Checkout.',
  },
  {
    term: 'retry',
    files: ['server/alerts/notifier.ts', 'server/apply/republish.ts'],
    reason: "A delivery's retries to an Alert Destination, and consumers' retry counts; the glossary means a Replay.",
  },
  {
    term: 'requeue',
    files: ['server/checkout/collect.ts', 'server/checkout/manager.ts', 'server/triage/delivery-budget.ts'],
    reason: "AMQP's own flag on basic.nack, what a Keep does underneath; the glossary means a Replay or a Keep.",
  },
  {
    term: 'user',
    files: ['server/amqp-connection.ts', 'server/apply/republish.ts', 'server/apply/types.ts', 'server/audit/audit-store.ts', 'server/audit/postgres-connection.ts', 'server/audit/restore.ts', 'server/broker-credentials.ts', 'server/broker-error.ts', 'server/checkout/apply.ts', 'server/checkout/errors.ts', 'server/checkout/open.ts', 'server/checkout/state.ts', 'server/main.ts', 'server/management.ts', 'server/metrics/runtime.ts', 'server/operator.ts', 'server/profiles.ts', 'server/replay-rules/pass.ts', 'server/run-mode.ts', 'server/server.ts', 'shared/audit.ts', 'shared/checkout.ts', 'shared/queues.ts', 'shared/replay-rules.ts', 'web/App.tsx'],
    reason: 'Broker and PostgreSQL users, $USER and CPU time; the glossary means the Operator.',
  },
  {
    term: 'pod',
    files: ['server/audit/sqlite-audit-store.ts'],
    reason: 'A Kubernetes object; the glossary means a Replica.',
  },
  { term: 'run', reason: 'Ordinary verb and noun; the glossary means a Rule Pass, which is always named as one.' },
  { term: 'record', reason: 'Ordinary verb and noun for what the audit store does; the glossary means a Message.' },
  { term: 'connection', reason: 'AMQP and PostgreSQL connections; the glossary means a Broker Profile.' },
  { term: 'history', reason: 'The history view and its store; the glossary means an Audit Entry.' },
  { term: 'who', reason: 'Ordinary English; the glossary means the Operator as a named role.' },
  { term: 'copy', reason: "Discard's copy of a Message, and the copy-audit-store command; the glossary means a Move." },
  { term: 'channel', reason: 'AMQP channels; the glossary means an Alert Destination.' },
  { term: 'lock', reason: "The Checkout's lock queue (ADR 0006) and in-process locks; the glossary means the Checkout itself." },
  { term: 'reading', reason: 'A reading of the management API; the glossary means a Sample.' },
  { term: 'node', reason: 'Graph nodes of the Dead-letter Map and Node.js; the glossary means a Replica.' },
  { term: 'expired', reason: "A stored body's retention, and RabbitMQ's expired reason; the glossary means a Lost Checkout." },
  { term: 'attempts', reason: "A Replay Rule's attempts and a delivery's; the glossary means a Delivery Budget." },
  { term: 'page', reason: 'Web pages; the glossary means an Alert.' },
  { term: 'metric', reason: 'Prometheus metrics; the glossary means a Sample.' },
  { term: 'drop', reason: 'What a broker or a pool does, and a fall in depth; the glossary means a Discard.' },
  { term: 'environment', reason: 'Environment variables; the glossary means a Broker Profile.' },
  { term: 'delete', reason: 'Deleting queues, rows and timers; the glossary means a Discard.' },
  { term: 'mark', reason: 'Ordinary verb; the glossary means a Decision.' },
  { term: 'ignore', reason: 'Ordinary verb; the glossary means a Keep.' },
  { term: 'commit', reason: 'Database commits; the glossary means an Apply.' },
  { term: 'timeout', reason: 'Network and consumer timeouts; the glossary means a Watch Window.' },
  { term: 'cycle', reason: 'Cycles in the Dead-letter Map; the glossary means a Rule Pass.' },
  { term: 'tick', reason: 'Ticking a Message in the web app, the clock; the glossary means a Rule Pass.' },
  { term: 'snapshot', reason: "The sampler's latest values and a database snapshot; the glossary means a Checkout." },
  { term: 'probe', reason: 'Kubernetes probes; the glossary means a Canary.' },
  { term: 'review', reason: "Reviewing the profiles file, and an Approval's review, which its definition uses." },
  { term: 'skip', reason: "MassTransit's own word for a Message no consumer handled (`MT-Reason: skip`)." },
  { term: 'fault', reason: "MassTransit's own word, which the glossary allows." },
  { term: 'event', reason: 'Node.js and DOM events and the event loop; the glossary means a Message or an Alert.' },
  { term: 'topology', reason: "RabbitMQ's word for a broker's set-up, outside the Dead-letter Map." },
  { term: 'notifier', reason: 'The module that delivers notifications; the glossary means an Alert Destination.' },
  { term: 'browse', reason: 'Browsing Audit Entries in the web app; the glossary means a Checkout.' },
  { term: 're-route', reason: 'Says what a Replay does not do.' },
  { term: 'job', reason: 'The retention job; the glossary means a Replay Rule.' },
  { term: 'incident', reason: 'An incident in the ordinary sense, outside the app; the glossary means an Alert.' },
  { term: 'trigger', reason: 'Ordinary verb; the glossary means an Alert Rule.' },
  { term: 'timed out', reason: 'A wait that timed out; the glossary means a Lost Checkout.' },
  { term: 'submit', reason: "A form's submit; the glossary means an Apply." },
  { term: 'monitor', reason: "Node's event-loop delay monitor; the glossary means an Alert Rule." },
  { term: 'execute', reason: "The executor's step function; the glossary means an Apply." },
  { term: 'batch', reason: 'A batch of rows in copy-audit-store; the glossary means a Selection.' },
  { term: 'action', reason: "The Audit Entry's `action` field, and triage actions as a class; the glossary means a Decision." },
  { term: 'permission', reason: 'RabbitMQ and PostgreSQL permissions; the glossary means a Role.' },
  { term: 'policy', reason: 'RabbitMQ policies, which the glossary reserves the word for.' },
  { term: 'delivery limit', reason: "RabbitMQ's own setting on a quorum queue, in setup warnings; the glossary means a Delivery Budget." },
];

function avoidedTerms(glossary: string): string[] {
  const terms = [...glossary.matchAll(/^_Avoid_: (.*)$/gm)].flatMap(([, list]) =>
    list!.split(/,(?![^(]*\))/).map((term) => term.replace(/\(.*\)/, '').trim().toLowerCase()),
  );
  return [...new Set(terms)].filter((term) => term !== '');
}

/** A term and its inflections, as whole words. */
function termPattern(term: string): RegExp {
  const words = term.split(/[\s-]+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const last = words.pop()!;
  const stem = last.replace(/(e|y)$/, '');
  const inflected = `(?:${last}|${stem}(?:s|es|ed|d|ing|ies|ied))`;
  return new RegExp(`\\b${[...words, inflected].join('[\\s-]+')}\\b`, 'i');
}

interface Prose {
  line: number;
  text: string;
}

const sql = /^\s*(CREATE|SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|WITH|BEGIN|PRAGMA|LOCK|GROUP|SUM)\b/;

/** The comments and multi-word strings of a TypeScript source, `code spans` taken out. */
function proseOf(fileName: string, source: string): Prose[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const prose: Prose[] = [];
  const add = (pos: number, text: string) => prose.push({ line: file.getLineAndCharacterOfPosition(pos).line + 1, text: text.replace(/`[^`]*`/g, ' ') });
  const commentsSeen = new Set<number>();
  const addComments = (pos: number) => {
    for (const range of [...(ts.getLeadingCommentRanges(source, pos) ?? []), ...(ts.getTrailingCommentRanges(source, pos) ?? [])]) {
      if (commentsSeen.has(range.pos)) continue;
      commentsSeen.add(range.pos);
      add(range.pos, source.slice(range.pos, range.end));
    }
  };
  // No types for the lint package's TypeScript here.
  const visit = (node: any) => {
    addComments(node.getFullStart());
    addComments(node.getEnd());
    const isText =
      ts.isStringLiteralLike(node) || ts.isJsxText(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
    const isCode = ts.isImportDeclaration(node.parent ?? {}) || (ts.isJsxAttribute(node.parent ?? {}) && node.parent.name.getText() === 'className');
    if (isText && !isCode && /\S\s+\S/.test(node.text) && !sql.test(node.text)) add(node.getStart(), node.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return prose;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('GLOSSARY avoided terms', () => {
  const terms = avoidedTerms(readFileSync(path.join(root, 'GLOSSARY.md'), 'utf8'));
  const src = path.join(root, 'src');
  const prose = sourceFiles(src).flatMap((file) => {
    const relative = path.relative(src, file);
    return proseOf(relative, readFileSync(file, 'utf8')).map((p) => ({ ...p, file: relative }));
  });
  const used = new Set<Exception>();

  it('reads the terms from the glossary, without what brackets add', () => {
    expect(terms).toContain('prod mode');
    expect(terms).toContain('policy');
    expect(avoidedTerms('_Avoid_: Policy (reserved for RabbitMQ policies, mostly), Job\n')).toEqual(['policy', 'job']);
  });

  it('takes comments and multi-word strings, not identifiers or code', () => {
    const texts = proseOf(
      'a.tsx',
      `// a comment word\nimport x from 'an import path';\nconst retry = 'retry';\nconst sql = 'SELECT session FROM t';\nconst m = \`the retry of \${retry} is \\\`code\\\` \`;\nconst e = <p className="two classes">jsx text</p>;\n`,
    ).map((p) => p.text.trim());
    expect(texts).toEqual(['// a comment word', 'the retry of', 'is', 'jsx text']);
  });

  it('matches a term in its inflections, as whole words', () => {
    expect(termPattern('retry').test('it retries twice')).toBe(true);
    expect(termPattern('delete').test('deleting it')).toBe(true);
    expect(termPattern('prod mode').test('in Prod  mode')).toBe(true);
    expect(termPattern('run').test('prune it')).toBe(false);
  });

  it('are not in src/ prose, apart from the listed exceptions', () => {
    const found: string[] = [];
    for (const term of terms) {
      const pattern = termPattern(term);
      for (const { file, line, text } of prose) {
        if (!pattern.test(text)) continue;
        const exception = exceptions.find((e) => e.term === term && (!e.files || e.files.includes(file)));
        if (exception) used.add(exception);
        else found.push(`${term}: ${file}:${line}: ${text.trim().replace(/\s+/g, ' ').slice(0, 100)}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('list exceptions that still apply', () => {
    for (const exception of exceptions) expect(terms, exception.term).toContain(exception.term);
    expect(exceptions.filter((e) => !used.has(e)).map((e) => e.term)).toEqual([]);
  });
});
