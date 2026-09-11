// One place that turns a freshly-rendered `docs/testing-stack.md` into a FULLY answered one,
// the way a team would. Shared because three suites need it and because the schema
// (src/testingstack.mjs) will keep growing: a helper that answers "every slot, whatever they
// are" cannot drift out of date the way three hand-written replace chains did.
//
// Every answer below is deliberately generic — no product name. A fixture that answered
// `store-query-idiom` with a real SQL dialect would put a customer technology back into the
// repository through the test suite, which is the exact leak the publish gate exists to catch.
import { readFileSync, writeFileSync } from 'node:fs';
import { validateTestingStack } from '../../src/testingstack.mjs';

/**
 * Answer every `UNFILLED — ` line, every `UNFILLED` slot cell and every `...` placeholder row in
 * the file at `path`, then assert the result actually schema-validates — so a suite that uses
 * this helper fails loudly if the schema gained a requirement the helper does not satisfy,
 * instead of silently testing a file that is still incomplete.
 * @param {string} path
 * @returns {string} the filled text
 */
export function fillTestingStack(path) {
  const filled = fillTestingStackText(readFileSync(path, 'utf8'));
  const { ok, problems } = validateTestingStack(filled, { path });
  if (!ok) {
    throw new Error(`fillTestingStack left the file incomplete — the schema grew and this helper did not:\n${problems.join('\n')}`);
  }
  writeFileSync(path, filled, 'utf8');
  return filled;
}

/**
 * The pure text transform behind {@link fillTestingStack}.
 * @param {string} text
 * @returns {string}
 */
export function fillTestingStackText(text) {
  return text
    .replace(/^STATUS: PARTIAL — .*$/m, 'STATUS: DONE')
    .replace(/^UNFILLED — .*$/gm, 'filled in by the team for this fixture.')
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t.startsWith('|') || !t.endsWith('|')) return line;
      // A slot row: `| \`key\` | prose | UNFILLED |` -> a real answer in the last cell.
      const cells = t.slice(1, -1).split('|').map((c) => c.trim());
      if (/^`[a-z0-9-]+`$/.test(cells[0]) && cells[cells.length - 1] === 'UNFILLED') {
        cells[cells.length - 1] = 'answered by the team for this fixture';
        return `| ${cells.join(' | ')} |`;
      }
      // A template placeholder row: replace every `...` cell with something runnable-looking.
      if (cells.some((c) => c === '...' || c === '…')) {
        return `| ${cells.map((c) => (c === '...' || c === '…' ? 'the fixture module, `run the fixture suite`' : c)).join(' | ')} |`;
      }
      return line;
    })
    .join('\n');
}
