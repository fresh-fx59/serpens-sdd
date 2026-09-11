// The CI-vendor-shape gate. `docs/SETUP.md:400,406` shipped one CI vendor's own declarative-
// pipeline block (a `stage('...') { steps { sh '...' } }` body, fenced under that vendor's
// pipeline-DSL language tag) naming the customer's CI system BY SHAPE, never by name — so
// `no-customer-tech-nouns.test.mjs`'s noun dictionary, which matches product names, could not
// see it. This is the same leak class that project already fixed for event transports and data
// stores in tester-facing prose: a customer's technology choice embedded in prose the customer
// never gets to swap out.
//
// The fix for the fence itself was manual (docs/SETUP.md rewritten to plain `bash`, which the
// reader adapts into their own CI job body). This test is the gate that keeps it fixed: no
// shipped kit file may fence a code block in a CI vendor's own pipeline DSL. A shell/bash fence
// is fine — every CI product this gate knows about runs shell steps, so `bash`/`sh` names no
// vendor. (The vendor names this gate checks for live only in the `BANNED_FENCES` dictionary
// below — `no-customer-tech-nouns.test.mjs` exempts that declaration by line range, the same
// way it exempts its own `BANNED` dictionary, so this file can name what it bans without
// tripping the gate it is a companion to.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveKitSource } from '../scripts/kit-source.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const VAULT_ROOT = join(PKG_ROOT, '..');

// Same shipped scope as the noun gate (no-customer-tech-nouns.test.mjs): the two kit trees plus
// the package's own shipped directories. A CI-DSL fence in `kits/` or `ports/` is exactly as
// much of a leak as one in the vault source kits.
const SHIPPED = [
  resolveKitSource('en'),
  resolveKitSource('ru'),
  join(PKG_ROOT, 'kits'),
  join(PKG_ROOT, 'bin'),
  join(PKG_ROOT, 'src'),
  join(PKG_ROOT, 'ports'),
  join(PKG_ROOT, 'tools'),
];

// Fence languages that identify a SPECIFIC CI vendor's own pipeline DSL — a reader cannot copy
// one of these into an arbitrary CI product's job body, because the syntax itself only runs on
// one vendor's engine. Each entry is the vendor whose pipeline syntax the tag names, and why
// that tag is unambiguously theirs (not a general-purpose language they merely support running).
const BANNED_FENCES = {
  groovy: 'Jenkins declarative/scripted pipeline DSL (Jenkinsfile) is written in Groovy; the ' +
    'language tag is how a Jenkinsfile snippet is conventionally fenced',
  jenkinsfile: 'names the vendor directly as a fence language',
  groovyfile: 'alternate Jenkinsfile fence spelling seen in the wild',
  hcl: 'HashiCorp Configuration Language is the syntax of a Terraform/Vault/Consul config; a ' +
    'kit CI example fenced as `hcl` is a Terraform Cloud / Atlantis pipeline snippet in ' +
    'disguise, not a generic instruction',
  'gitlab-ci': 'GitLab CI job YAML has vendor-specific keys (`stages`, `only`, `rules`) ' +
    'distinct from generic YAML; some renderers accept this as a fence language name',
};

// `yaml` itself is NOT banned. `docs/SETUP.md` fences two legitimate `yaml` blocks (an OpenSpec
// `openspec/config.yaml` `references:` block) — that is this kit's OWN config format, not a CI
// vendor's pipeline syntax, and most CI products' job files also happen to be plain YAML.
// Banning `yaml` would both miss nothing real (a generic YAML fence names no vendor) and take
// out legitimate content this kit ships. The vendor signal is a DSL/tag that only one product's
// engine parses (`groovy`, `hcl`) or a vendor-specific YAML dialect keyword set, not the YAML
// format itself.

/**
 * Collect every scannable file under `root`.
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

const FENCE_RE = /^```([A-Za-z0-9_-]+)\s*$/;

/**
 * Every banned-fence-language occurrence across `roots`, as `{file, line, lang, why}`.
 * @param {string[]} roots
 * @returns {Array<{file: string, line: number, lang: string, why: string}>}
 */
export function findCiVendorFences(roots = SHIPPED) {
  const hits = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      let text;
      try { text = readFileSync(file, 'utf8'); } catch { continue; }
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        const m = FENCE_RE.exec(line.trim());
        if (!m) return;
        const lang = m[1].toLowerCase();
        if (BANNED_FENCES[lang]) {
          hits.push({ file: relative(VAULT_ROOT, file), line: i + 1, lang, why: BANNED_FENCES[lang] });
        }
      });
    }
  }
  return hits;
}

test('the shipped kit fences no code block in a CI vendor\'s own pipeline DSL', () => {
  const hits = findCiVendorFences();
  const report = hits.map((h) => `  ${h.file}:${h.line}  [\`${h.lang}\`] ${h.why}`).join('\n');
  assert.deepEqual(hits, [],
    `\nThe shipped kit fences ${hits.length} code block(s) in a CI vendor's own pipeline DSL.\n`
    + 'A kit CI example must be adaptable to ANY CI product: fence it as `bash`/`sh` and let the\n'
    + `reader wrap it in their own job body.\n\n${report}\n`);
});

test('the CI-vendor-DSL gate catches a planted groovy fence, so a green run means something', () => {
  const planted = findCiVendorFences([join(__dirname, 'fixtures', 'ci-vendor-dsl')]);
  assert.ok(planted.length >= 1, 'the planted fixture must be detected');
  assert.ok(planted.some((h) => h.lang === 'groovy'));
});

test('a neutral bash fence describing a CI step passes the gate', () => {
  assert.deepEqual(findCiVendorFences([join(__dirname, 'fixtures', 'ci-neutral')]), []);
});
