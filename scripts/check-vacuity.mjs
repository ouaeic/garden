#!/usr/bin/env node
/**
 * The loop-vacuity check: a test whose every assertion can be skipped by an empty collection.
 *
 *   node scripts/check-vacuity.mjs            fail on any test not on the ledger below
 *   node scripts/check-vacuity.mjs --list     print every finding, ledger included
 *
 * ── What it looks for, and why that shape and not another ──────────────────────────────────────
 *
 * One signature, and it is always the same one: every `expect` in the test body sits inside a loop
 * over a collection the test did not write down, and nothing outside the loop says the collection
 * has anything in it. Empty the collection and the body never runs, the test passes in 0 ms, and
 * the report says green. Twenty-four of these were confirmed by mutation in this repository - among
 * them a command-injection guard that passes on an empty table of image types, a regression test
 * for a defect that handed the model unreadable file paths, and an AGPL compliance claim that
 * cannot fail. Emptying `connectorCatalog`, every connectable service the product offers, broke one
 * test out of 249 in `packages/core`.
 *
 * The class regenerates, because a loop-only assertion is the cheapest way to write a test that can
 * never fail, and it looks exactly like a thorough one. So the guard is a check rather than a round
 * of edits, which would only hold until the next such test was written.
 *
 * The repository had already written the cure once, in `skills.test.ts`, and never generalised it:
 *
 *     // A regex that stopped matching would pass this silently, which is the failure the check
 *     // exists to prevent wearing the costume of a pass.
 *     expect(checked).toBeGreaterThan(0);
 *
 * That is exactly what this looks for - one assertion the empty case still has to answer for.
 *
 * ── What is deliberately not flagged ───────────────────────────────────────────────────────────
 *
 * A loop over an array or object literal written in the test itself. That collection cannot be
 * emptied by a change to the product; emptying it is editing the test's own data, which is a
 * different act and a visible one. Flagging those would bury the real findings under table-driven
 * tests, and a check whose output nobody reads is a check that has stopped running.
 *
 * `expect.assertions(n)` and `expect.hasAssertions()` also clear a test, because they are the
 * assertion the empty case fails: vitest fails the test when the count is not met.
 *
 * ── Why an AST and not a regex ─────────────────────────────────────────────────────────────────
 *
 * Because the two cases that matter are exactly the ones a regex confuses. `skills.test.ts:373`
 * asserts inside a `for…of`; twenty lines below, another test asserts on a count after its loop.
 * They are the same characters in a different tree. TypeScript is already a dependency of this
 * repository and parsing 206 test files with it costs about a second.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The tests that were still standing when this check was written. It is empty, and that is the
 * whole point of it.
 *
 * It held fifty-one entries. Twenty-five of those were repaired - each given one assertion the
 * empty case has to answer, a count before the loop or after it - and the other twenty-six were
 * this check being wrong about a table the test wrote down itself: `const cases = [...]` two lines
 * above the loop, a `satisfies`-checked map at the top of the file, `Object.entries(cases)`, a
 * `for (let attempt = 0; attempt < 8; ...)`. Every one of those was the burial the header warns
 * about - real findings under table-driven tests - and the fix was in the parser, not in the
 * tests.
 *
 * An empty ledger is a ratchet: the next test of this shape fails the build on the commit that
 * writes it, which is the only moment it is cheap to fix. Adding an entry here is not free and is
 * not a way past a red build. It is a promise, in writing, that somebody will come back - and this
 * repository has already learned what a list of those is worth after nobody does.
 */
const LEDGER = new Set([]);

const files = spawnSync('git', ['ls-files', '*.test.ts', '*.test.tsx'], {
  cwd: root,
  encoding: 'utf8'
});
if (files.status !== 0) {
  process.stderr.write('check-vacuity: git ls-files failed; this must run inside the checkout.\n');
  process.exit(2);
}

/** `it`, `test`, and the modified forms - `it.only` hides a vacuous test just as well. */
const isTestOpener = (node) => {
  if (!ts.isCallExpression(node)) return false;
  const target = node.expression;
  const name = ts.isPropertyAccessExpression(target) ? target.expression : target;
  return ts.isIdentifier(name) && (name.text === 'it' || name.text === 'test');
};

/** The array-method loops, which are loops in every way that matters here. */
const ITERATING_METHODS = new Set([
  'forEach',
  'map',
  'filter',
  'flatMap',
  'some',
  'every',
  'find',
  'findIndex',
  'reduce',
  'sort'
]);

/**
 * A literal that cannot be emptied by a change to the product.
 *
 * A spread is the exception and it is the whole reason this is a function rather than two calls to
 * `ts.isArrayLiteralExpression`: `[...connectorCatalog]` is an array literal whose contents are a
 * production collection, and emptying that collection empties it. Treating it as a literal would
 * excuse exactly the defect this check exists for, wearing brackets.
 */
const isClosedLiteral = (node, bound) => {
  if (ts.isArrayLiteralExpression(node))
    return node.elements.every(
      (element) => !ts.isSpreadElement(element) || iteratesALiteral(element.expression, bound)
    );
  if (ts.isObjectLiteralExpression(node))
    return node.properties.every(
      (property) => !ts.isSpreadAssignment(property) || iteratesALiteral(property.expression, bound)
    );
  return false;
};

/**
 * Whether the thing being iterated is written down in the test.
 *
 * A literal cannot be emptied by a change to the product, so a loop over one is not this defect.
 * `Object.keys({...})`, `Object.entries({...})` and `[...].map(...)` chains resolve to the literal
 * at their root, which is why this walks left rather than testing the immediate expression.
 *
 * `bound` carries the names the enclosing test declared with a literal initialiser, because the
 * ordinary way to write a table-driven test is two statements and not one:
 *
 *     const cases = [{ url: '/v1/tasks/page', code: 'task_not_found' }, ...];
 *     for (const { url, code } of cases) ...
 *
 * That is the same act as looping over the literal inline - the data is in the test, emptying it is
 * editing the test - and flagging it was the check's own documented mistake: "flagging those would
 * bury the real findings under table-driven tests, and a check whose output nobody reads is a check
 * that has stopped running". Twenty-seven of the fifty-one it first reported were this shape, which
 * is exactly the burial it warned about.
 */
const iteratesALiteral = (expression, bound = new Set()) => {
  let node = expression;
  for (;;) {
    if (isClosedLiteral(node, bound)) return true;
    if (ts.isIdentifier(node)) return bound.has(node.text);
    if (ts.isCallExpression(node)) {
      // `Object.keys(cases)` holds its collection in the argument, not in the receiver, and walking
      // left from it lands on the identifier `Object`. The header claimed this case was covered and
      // the code never covered it: `connector-origin-totality.test.ts` walks a compiler-enforced
      // total table through `Object.entries` and was reported for years as a test that checks
      // nothing. Only these three, by name - a call to anything else may return an empty array on a
      // full argument, and excusing that would certify the defect this file exists to catch.
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'Object' &&
        ['keys', 'values', 'entries'].includes(callee.name.text) &&
        node.arguments.length === 1
      ) {
        node = node.arguments[0];
        continue;
      }
      node = callee;
      continue;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      node = node.expression;
      continue;
    }
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      node = node.expression;
      continue;
    }
    return false;
  }
};

/**
 * The names a test binds to data it wrote down itself.
 *
 * Only `const name = <literal>` counts, and only inside this test's own body: a `let` that is
 * reassigned, a destructuring, or a name from an outer scope could all be pointed at something the
 * product owns without this seeing it, and a check that guesses in the permissive direction is a
 * check that certifies the thing it was built to catch. Chained literals resolve too, so
 * `const rows = CASES.map(...)` is a literal when `CASES` is one.
 */
const literalsBoundIn = (body, inherited = new Set()) => {
  const bound = new Set(inherited);
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      node.parent.flags & ts.NodeFlags.Const &&
      iteratesALiteral(node.initializer, bound)
    )
      bound.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return bound;
};

/**
 * The loop, if this node is one, together with what it iterates.
 *
 * `for (;;)` and `while` are counted with no collection: a hand-rolled loop whose bound is a length
 * is the same defect wearing different syntax, and there is nothing to call a literal.
 */
const loopOf = (node, bound) => {
  if (ts.isForOfStatement(node) || ts.isForInStatement(node))
    return { literal: iteratesALiteral(node.expression, bound) };
  // `for (let attempt = 0; attempt < 8; ...)` runs eight times on every machine there has ever
  // been. It is a repetition, not an iteration, and there is nothing to empty; `i < rows.length`
  // is the shape that matters and it keeps its finding, because that bound IS a collection.
  if (ts.isForStatement(node))
    return {
      literal: Boolean(
        node.condition &&
        ts.isBinaryExpression(node.condition) &&
        (ts.isNumericLiteral(node.condition.right) || ts.isNumericLiteral(node.condition.left))
      )
    };
  if (ts.isWhileStatement(node) || ts.isDoStatement(node)) return { literal: false };
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ITERATING_METHODS.has(node.expression.name.text)
  )
    return { literal: iteratesALiteral(node.expression.expression, bound) };
  return null;
};

const findings = [];

for (const relative of files.stdout.split('\n').filter(Boolean)) {
  const absolute = path.join(root, relative);
  const source = ts.createSourceFile(
    absolute,
    readFileSync(absolute, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );

  // The same table written above the describes rather than inside them. `readsThrough` in
  // `connector-origin-totality.test.ts` is the case: a const object literal at the top of the test
  // file, whose totality the compiler enforces with `satisfies`. It is the test's own data wherever
  // in the file it sits, and emptying it is still editing the test.
  const fileLiterals = literalsBoundIn(source);

  const inspect = (node) => {
    if (isTestOpener(node)) {
      const [title, body] = node.arguments;
      if (body) {
        let assertions = 0;
        let outsideALoop = 0;
        let cleared = false;
        const bound = literalsBoundIn(body, fileLiterals);
        // Depth of enclosing loops that iterate something the test did not write down. A literal
        // loop deliberately contributes nothing, so an assertion inside one still counts as an
        // assertion the empty case has to answer.
        const walk = (child, depth) => {
          if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression)) {
            const target = child.expression.expression;
            if (
              ts.isIdentifier(target) &&
              target.text === 'expect' &&
              (child.expression.name.text === 'assertions' ||
                child.expression.name.text === 'hasAssertions')
            )
              cleared = true;
          }
          if (
            ts.isCallExpression(child) &&
            ts.isIdentifier(child.expression) &&
            child.expression.text === 'expect'
          ) {
            assertions += 1;
            if (depth === 0) outsideALoop += 1;
          }
          const loop = loopOf(child, bound);
          const next = loop && !loop.literal ? depth + 1 : depth;
          ts.forEachChild(child, (grandchild) => walk(grandchild, next));
        };
        ts.forEachChild(body, (child) => walk(child, 0));
        if (assertions > 0 && outsideALoop === 0 && !cleared) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          const name =
            title && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))
              ? title.text
              : '<computed name>';
          findings.push({ file: relative, line: line + 1, name });
        }
      }
    }
    ts.forEachChild(node, inspect);
  };
  ts.forEachChild(source, inspect);
}

const key = (finding) => `${finding.file}::${finding.name}`;
const unledgered = findings.filter((finding) => !LEDGER.has(key(finding)));
const found = new Set(findings.map(key));
const repaired = [...LEDGER].filter((entry) => !found.has(entry));

if (process.argv.includes('--list'))
  for (const finding of findings)
    process.stdout.write(
      `${LEDGER.has(key(finding)) ? 'ledger' : 'NEW   '} ${finding.file}:${finding.line}  ${finding.name}\n`
    );

if (unledgered.length) {
  process.stderr.write(
    `\n${unledgered.length} test${unledgered.length === 1 ? '' : 's'} can be satisfied by an empty collection:\n\n`
  );
  for (const finding of unledgered)
    process.stderr.write(`  ${finding.file}:${finding.line}\n    ${finding.name}\n`);
  process.stderr.write(
    '\nEvery assertion in each of these sits inside a loop over a collection the test did not write\n' +
      'down. Empty that collection and the test passes in no time at all, having checked nothing.\n' +
      'Give it one assertion the empty case has to answer - a count after the loop, or a length\n' +
      'before it - or delete the test with the behaviour it was pinning.\n'
  );
}

if (repaired.length) {
  process.stderr.write(
    `\n${repaired.length} ledger entr${repaired.length === 1 ? 'y is' : 'ies are'} no longer vacuous, or no longer exist${repaired.length === 1 ? 's' : ''}:\n\n`
  );
  for (const entry of repaired) process.stderr.write(`  ${entry}\n`);
  process.stderr.write(
    '\nGood news, and it has to be recorded: delete these lines from LEDGER in this file. A ledger\n' +
      'that keeps entries after they are fixed is a list nobody trusts, and then a list nobody reads.\n'
  );
}

if (unledgered.length || repaired.length) process.exit(1);
process.stdout.write(
  `check-vacuity: ${findings.length} known loop-only test${findings.length === 1 ? '' : 's'}, none new.\n`
);
