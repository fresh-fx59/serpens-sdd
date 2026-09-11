// The publish gate. Edition 2026-09-09.1 shipped two customer technology nouns in its prose —
// one event transport and one data store, the store named together with a table — through
// commands/spns-test-plan.md into a package about to go public. The manual sanitization pass
// that was supposed to catch that had already run and reported clean. This test replaces the human pass: a noun the CUSTOMER chose may not
// appear anywhere in the shipped kit, and the build fails if one does.
//
// The line is generic-versus-identifying, not process-versus-technology. The kit may name its
// OWN toolchain — git, node, lefthook, OpenSpec, ctags, Zoekt, npm — the way a deployment chart
// may name the orchestrator it targets. It may not name what the customer runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveKitSource } from '../scripts/kit-source.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const VAULT_ROOT = join(PKG_ROOT, '..');

// Everything a customer actually receives: the two vault kit trees, and every directory
// package.json's `files` list ships. `kits/` alone was the original scope, and the tarball made
// the case for widening it — a `tools/gen-index.mjs` comment illustrated renamed clones with a
// named CI system's workspaces, in a file the noun gate never looked at.
// `ports/` is in scope too and stays clean by construction: those files name AGENT CLIs, which
// are this kit's own compatibility surface (40 of them), never a customer's infrastructure.
// The two kit trees are resolved, never spelled: this vault names them `serpens-sdd-starter*`,
// the public repository names the same trees `en/` and `ru/`. resolveKitSource throws naming
// both candidates if neither exists, so this gate can never quietly scan nothing.
const SHIPPED = [
  resolveKitSource('en'),
  resolveKitSource('ru'),
  join(PKG_ROOT, 'kits'),
  join(PKG_ROOT, 'bin'),
  join(PKG_ROOT, 'src'),
  join(PKG_ROOT, 'ports'),
  join(PKG_ROOT, 'tools'),
];

// Everything that becomes PUBLIC when the package moves into its own public repository but is
// NOT in the npm tarball: the test suite, the release/vendor scripts, the manifest, and any CI
// workflow. These were never scanned while the repo was private, and an adversarial read found
// customer-identifying prose in exactly that unscanned band. `package.json` is a FILE root, not
// a directory — `walk()` accepts either. `.github/` is included when present so a workflow
// added later is covered the day it lands, without another edit here.
const PUBLIC_ONLY = [
  join(PKG_ROOT, 'test'),
  join(PKG_ROOT, 'scripts'),
  join(PKG_ROOT, 'package.json'),
  join(PKG_ROOT, '.github'),
].filter((p) => existsSync(p));

// The noun gate's scope: everything shipped, plus everything that goes public with the repo.
// The SHAPE gate below deliberately keeps the narrower `SHIPPED` scope — its globs match
// `commands/spns-*.md`, and `test/fixtures/` holds planted copies of exactly those files.
const NOUN_SCOPE = [...SHIPPED, ...PUBLIC_ONLY];

// Products a CUSTOMER picks. Grouped only for legibility in a failure message.
const BANNED = {
  'event transport': ['Kafka', 'RabbitMQ', 'Pulsar', 'NATS', 'ActiveMQ', 'Kinesis', 'SQS'],
  'data store': ['ClickHouse', 'Postgres', 'PostgreSQL', 'MySQL', 'MariaDB', 'Oracle', 'MongoDB',
    'Cassandra', 'DynamoDB', 'Elasticsearch', 'OpenSearch', 'Redis', 'Snowflake', 'BigQuery'],
  'HTTP client': ['Insomnia', 'Postman', 'Bruno', 'Paw'],
  'CI system': ['Jenkins', 'TeamCity', 'CircleCI', 'Travis', 'Bamboo', 'Drone', 'Buildkite'],
  'tracker or forge': ['Jira', 'Confluence', 'Bitbucket', 'Atlassian', 'YouTrack', 'Redmine',
    'Azure DevOps', 'ServiceNow'],
  'stream processing': ['Flink', 'NiFi', 'Spark', 'Airflow', 'Storm', 'Beam'],
  'application framework': ['Spring Boot', 'Quarkus', 'Micronaut', 'Django', 'Rails',
    'Laravel', 'FastAPI', 'Next.js', 'Nest.js'],
  'runtime the customer chose': ['Kubernetes', 'OpenShift', 'Nomad', 'Vault', 'Consul'],
};

// The kit's OWN prerequisites. Naming these is the kit describing itself, not the customer.
// Kept as a list rather than a comment so a reviewer can see exactly what was permitted.
const KIT_OWN_TOOLCHAIN = ['git', 'node', 'npm', 'npx', 'lefthook', 'OpenSpec', 'openspec',
  'ctags', 'Universal Ctags', 'Zoekt', 'zoekt', 'bash', 'Markdown', 'YAML', 'JSON'];

/**
 * Collect every scannable file under `root`. `root` may be a DIRECTORY or a single FILE — the
 * public scope includes `package.json`, which has no directory to walk. `node_modules/` and
 * `.git/` are skipped: neither is authored content and neither goes public.
 * @param {string} root
 * @param {string[]} [out]
 * @returns {string[]}
 */
function walk(root, out = []) {
  const st = statSync(root);
  if (!st.isDirectory()) {
    if (st.size < 2_000_000) out.push(root);
    return out;
  }
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walk(p, out);
    } else if (statSync(p).size < 2_000_000) out.push(p);
  }
  return out;
}

// --- Exemptions. Both are as narrow as they can be made, because an exemption is a hole in the
// gate and the gate now scans its own source.
//
// 1. A dictionary declaration that must CONTAIN the nouns it checks for, in THIS file or a
//    sibling gate. Each is exempt — by LINE RANGE, read out of the source at run time, never by
//    whole file. Exempting the whole file would leave the file most likely to name a product
//    completely unguarded; the prose above and below a dictionary is still scanned, which is
//    what the incident narratives in this header had to be rewritten to satisfy.
//    `no-ci-vendor-dsl.test.mjs`'s `BANNED_FENCES` is the second entry: that gate's dictionary
//    names the same class of CI-vendor product this file's own `BANNED['CI system']` does, for
//    the same reason — a CI-vendor-DSL gate that cannot name the vendors it bans cannot
//    explain what it is banning.
const DICTIONARY_DECLARATIONS = [
  { file: join(__dirname, 'no-customer-tech-nouns.test.mjs'), starts: 'const BANNED = {', ends: '};' },
  { file: join(__dirname, 'no-ci-vendor-dsl.test.mjs'), starts: 'const BANNED_FENCES = {', ends: '};' },
].filter((d) => existsSync(d.file));

/** @returns {{from: number, to: number}} 1-based inclusive line range of `decl`'s dictionary literal. */
function dictionaryLineRange(decl) {
  const lines = readFileSync(decl.file, 'utf8').split('\n');
  const from = lines.findIndex((l) => l.startsWith(decl.starts));
  if (from < 0) throw new Error(`${decl.starts} not found in ${decl.file} — the self-exemption is stale`);
  let to = from;
  while (to < lines.length && !lines[to].startsWith(decl.ends)) to++;
  return { from: from + 1, to: to + 1 };
}

// 2. Fixtures that exist TO BE DETECTED. `fixtures/customer-tech/planted.md` is the negative
//    control for this very gate: the "catches a planted noun" test asserts that its nouns are
//    found. Allowlisted by exact path, so a noun planted anywhere else under `test/fixtures/`
//    still fails the build.
const FIXTURE_ALLOWLIST = [
  relative(VAULT_ROOT, join(__dirname, 'fixtures', 'customer-tech', 'planted.md')),
];

/**
 * True when a hit is one of the two deliberate, documented exceptions above.
 * @param {{file: string, line: number}} hit
 * @returns {boolean}
 */
export function isExemptNounHit(hit) {
  if (FIXTURE_ALLOWLIST.includes(hit.file)) return true;
  for (const decl of DICTIONARY_DECLARATIONS) {
    if (hit.file !== relative(VAULT_ROOT, decl.file)) continue;
    const { from, to } = dictionaryLineRange(decl);
    if (hit.line >= from && hit.line <= to) return true;
  }
  return false;
}

/**
 * Every banned-noun occurrence in the shipped trees, as `{file, line, noun, category, text}`.
 * Word-boundary matched and case-sensitive on the product's own spelling, so `corpus` cannot
 * trip a `corp` rule and a lowercase spelling in prose cannot trip a capitalized product name.
 * @returns {Array<{file: string, line: number, noun: string, category: string, text: string}>}
 */
export function findCustomerTechNouns(roots = NOUN_SCOPE) {
  const hits = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      if (file.endsWith('.zip')) continue;
      let text;
      try { text = readFileSync(file, 'utf8'); } catch { continue; }
      const lines = text.split('\n');
      for (const [category, nouns] of Object.entries(BANNED)) {
        for (const noun of nouns) {
          const re = new RegExp(`(^|[^A-Za-z0-9_-])${noun.replace('.', '\\.')}([^A-Za-z0-9_-]|$)`);
          lines.forEach((line, i) => {
            if (re.test(line)) {
              hits.push({ file: relative(VAULT_ROOT, file), line: i + 1, noun, category, text: line.trim().slice(0, 110) });
            }
          });
        }
      }
    }
  }
  return hits;
}

test('the shipped kit names no technology the customer chose', () => {
  const hits = findCustomerTechNouns().filter((h) => !isExemptNounHit(h));
  const report = hits.map((h) => `  ${h.file}:${h.line}  [${h.category}: ${h.noun}]\n    ${h.text}`).join('\n');
  assert.deepEqual(hits, [],
    `\nThe shipped kit names ${hits.length} customer technolog${hits.length === 1 ? 'y' : 'ies'}.\n`
    + 'Move the fact into a layer file the command READS, do not just delete the word:\n'
    + 'a repository fact belongs in docs/testing-stack.md, an estate fact in the store\'s\n'
    + `conventions/. The kit may still name its own toolchain (${KIT_OWN_TOOLCHAIN.slice(0, 6).join(', ')}, …).\n\n${report}\n`);
});

test('the checker catches a planted noun, so a green run means something', () => {
  const planted = findCustomerTechNouns([join(__dirname, 'fixtures', 'customer-tech')]);
  assert.ok(planted.length >= 1, 'the planted fixture must be detected');
  // Named through the dictionary rather than spelled out, so this file carries no product name
  // outside the BANNED declaration itself (which the gate exempts by line, see isExemptNounHit).
  const plantedNoun = BANNED['event transport'][0];
  assert.ok(planted.some((h) => h.noun === plantedNoun), `expected the planted ${plantedNoun} hit`);
});

// The scope itself is now an assertion. The widening above is invisible in a green run — the
// public band is clean, so dropping a root back out of NOUN_SCOPE would also be green. This
// test is what makes that regression fail instead.
test('the noun gate scans the whole PUBLIC surface, not just the tarball', () => {
  const scanned = NOUN_SCOPE.flatMap((root) => walk(root)).map((f) => relative(PKG_ROOT, f));
  assert.ok(scanned.includes('package.json'), 'package.json must be scanned (a FILE root)');
  assert.ok(scanned.some((f) => f.startsWith('test/')), 'test/ must be scanned');
  assert.ok(scanned.some((f) => f.startsWith('scripts/')), 'scripts/ must be scanned');
});

test('the kit\'s own toolchain is NOT flagged', () => {
  const hits = findCustomerTechNouns([join(__dirname, 'fixtures', 'own-toolchain')]);
  assert.deepEqual(hits, [], 'naming git/node/lefthook/OpenSpec must stay legal');
});

// ---------------------------------------------------------------------------
// The SECOND half of the gate, and the one that took a review to see.
//
// `codex exec` reviewed the noun list above and made the correction that changed the unit of
// work: *"remove unconditional SQL, JSON, topic/key, and `curl` assumptions; noun removal alone
// leaves customer behavior embedded."* It is right. Deleting the transport's product name while
// the next line still said "the topic, the message key if the topic is keyed" and "the
// dead-letter topic" still described that same transport to any reader. `INSERT`/`SELECT` still assumed a SQL store, a
// complete-JSON-event body still assumed a JSON broker, and `curl` still assumed HTTP.
//
// So the two TESTER-FACING commands may name no wire shape either. Everything they need comes
// through a named slot in `docs/testing-stack.md`, which the repository — not the kit — answers.
// The gate is scoped to those two files on purpose: the kit legitimately says `JSON` elsewhere
// (openspec/index.json is the kit's OWN artifact) and legitimately says `curl` in setup docs
// about reaching its own tooling. It is only in a tester-facing plan that these words are the
// customer's stack in disguise.
// `templates/testing-stack.md` is in scope too, and that was Codex's second correction on this
// gate. The first version scoped the shape rules to the two commands only, and the template then
// quietly did the prescribing instead: `http-request-idiom` asked for "path, headers, auth,
// body", which is an HTTP request. An unauthenticated TCP PING/PONG service supplies none of
// those, so the question itself named a protocol family the repository never chose — the same
// leak as naming the broker, one level up. The two request slots are now `request-client` and
// `request-idiom`, and this gate is what keeps them that way.
// Scope, third revision. It started as the two tester-facing commands; Codex's review added the
// template. Then an audit of the OTHER eleven files found the shape language had simply moved
// upstream: `spns-spec` wrote the `OBSERVABLE CONTRACT` block as "per endpoint — method, full
// path…; per topic — name, message key", and `spns-test-plan` READS that block — so the consumer
// was clean and the producer was not. `spns-plan`, `spns-drill-down` and `spns-verification`
// carried smaller versions of the same thing.
//
// So the scope is now EVERY command and skill, plus the template. Anything a repository must
// supply is named through a slot, everywhere, or this gate fails.
const SHAPE_SCOPED_GLOBS = [/\/commands\/spns-[^/]+\.md$/, /\/skills\/spns-[^/]+\/SKILL\.md$/, /\/templates\/testing-stack\.md$/];

const BANNED_SHAPES = [
  { pattern: /\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE FROM\b/, why: 'assumes a SQL store — use the `store-query-idiom` / `store-seed-idiom` slots' },
  { pattern: /\bcurl\b/, why: 'assumes an HTTP command-line client — use the `http-client` slot' },
  { pattern: /\btopics?\b|\bтопик/i, why: 'assumes a topic-addressed broker — use the `event-addressing` slot' },
  { pattern: /\bdead-letter\b/, why: 'assumes a dead-letter destination — use the `error-routing` slot' },
  { pattern: /\bJSON\b/, why: 'assumes a JSON payload — use the `event-payload-format` slot' },
  { pattern: /\bHTTPS?\b/, why: 'assumes one protocol family — the `request-client` / `request-idiom` slots must stay protocol-neutral' },
  { pattern: /\bmessage key\b|\bключ сообщения\b/, why: 'assumes a keyed destination — use the `event-addressing` slot' },
  { pattern: /\bqueue\b|\bexchange\b|\brouting key\b|\bочеред/i, why: 'names one addressing model — `event-addressing` must ask, not enumerate' },
];

/**
 * Every banned-shape occurrence in the tester-facing commands of the shipped trees.
 * @returns {Array<{file: string, line: number, why: string, text: string}>}
 */
export function findShapeAssumptions(roots = SHIPPED) {
  const hits = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      if (!SHAPE_SCOPED_GLOBS.some((re) => re.test(file))) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const { pattern, why } of BANNED_SHAPES) {
          if (pattern.test(line)) {
            hits.push({ file: relative(VAULT_ROOT, file), line: i + 1, why, text: line.trim().slice(0, 110) });
          }
        }
      });
    }
  }
  return hits;
}

test('the tester-facing commands assume no wire shape the repository did not supply', () => {
  const hits = findShapeAssumptions();
  const report = hits.map((h) => `  ${h.file}:${h.line}  ${h.why}\n    ${h.text}`).join('\n');
  assert.deepEqual(hits, [],
    `\n${hits.length} shape assumption(s) survive in a tester-facing command.\n`
    + 'The command must name a SLOT of docs/testing-stack.md, not the shape itself:\n\n'
    + `${report}\n`);
});

test('the shape checker catches a planted assumption, so a green run means something', () => {
  const planted = findShapeAssumptions([join(__dirname, 'fixtures', 'shape-assumption')]);
  assert.ok(planted.length >= 4, `expected the planted fixture's assumptions, got ${planted.length}`);
  assert.ok(planted.some((h) => /SQL store/.test(h.why)));
  assert.ok(planted.some((h) => /topic-addressed/.test(h.why)));
});

test('the shape checker also scans the TEMPLATE, not just the commands', () => {
  const planted = findShapeAssumptions([join(__dirname, 'fixtures', 'shape-assumption-template')]);
  assert.ok(planted.some((h) => /protocol family/.test(h.why)),
    'a slot that asks for HTTP request parts must be caught in the template too');
  assert.ok(planted.every((h) => h.file.endsWith('templates/testing-stack.md')));
});

test('a slot-driven tester-facing command passes the shape checker', () => {
  assert.deepEqual(findShapeAssumptions([join(__dirname, 'fixtures', 'slot-driven')]), []);
});
