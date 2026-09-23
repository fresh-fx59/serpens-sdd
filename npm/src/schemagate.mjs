// schemagate.mjs — Option C for item 4b (project-local custom OpenSpec schemas), per
// content/enterprise-sdd-agents/spec-skipspecs-and-custom-schemas-2026-09-11.md §4b.
//
// WHY THIS EXISTS. OpenSpec resolves a schema by precedence: project-local
// `<projectRoot>/openspec/schemas/<name>/schema.yaml`, then a user override under
// XDG_DATA_HOME, then the package's own built-ins (verified against a real `openspec@1.13`
// install: `dist/core/artifact-graph/resolver.js:114-116`). Serpens-sdd's kit commands only
// understand the built-in `spec-driven` schema's four artifact ids (proposal, specs, design,
// tasks) — a project that resolves ANY other schema would silently pass planning and then fail,
// or worse, half-succeed, at implementation. Real support (a mapping file translating an
// arbitrary schema's artifact graph onto our commands) is deferred (tracked as option A in the
// spec's own labelling). Until then: detect it and STOP, loudly, before anything is written.
//
// Verified against a real `npx @fission-ai/openspec@1.13` install (2026-09-23): `schemas --json`
// returns `[{name, description, artifacts, source: 'project'|'package'}]`; a project-local
// schema at `openspec/schemas/<name>/schema.yaml` shows up with `source: 'project'`, and
// `openspec status --change <id> --json` reports the resolved `schemaName` for that change,
// which a per-change `openspec/changes/<id>/.openspec.yaml`'s own `schema:` key can override
// ahead of the project default in `openspec/config.yaml`. This module detects the same
// precedence STATICALLY (file reads only) so the gate has no runtime dependency on the
// `openspec` binary being on PATH — the CLI check function below runs in every kit-command
// precondition, and a missing dependency there must not be mistaken for "schema is fine".

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The only schema ids serpens-sdd's kit commands understand today. */
export const BUILTIN_SCHEMA_IDS = ['spec-driven'];

/**
 * Read a top-level (column-0) scalar YAML key's value from raw text, e.g. `schema: my-custom`.
 * Handles the one quoting form OpenSpec itself writes (plain, unquoted) plus single/double
 * quotes, and ignores the key inside a block scalar (`context: |` etc.) by only ever matching
 * a line that starts the key at column 0 — a block-scalar body is indented, never at column 0.
 * @param {string} text
 * @param {string} key
 * @returns {string|null}
 */
export function readTopLevelScalar(text, key) {
  const re = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm');
  const m = re.exec(text);
  if (!m) return null;
  let v = m[1].replace(/[ \t]+#.*$/, '').trim();
  if (v === '') return null;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v || null;
}

/**
 * Detect the FIRST OpenSpec schema in effect for a project that serpens-sdd does not support,
 * checked in the same precedence OpenSpec itself resolves (most-specific first):
 *   1. a project-local schema directory naming something other than a built-in
 *      (`openspec/schemas/<name>/schema.yaml`) — its mere existence means OpenSpec will resolve
 *      that name ahead of any package built-in of the same name;
 *   2. a per-change override (`openspec/changes/<id>/.openspec.yaml`'s `schema:` key);
 *   3. the project default (`openspec/config.yaml`'s top-level `schema:` key).
 * Archived changes (`openspec/changes/archive/`) are not scanned — done work, not in effect.
 * @param {string} repoRoot - the project root (where `openspec/` lives, if present)
 * @returns {{ok: true} | {ok: false, schemaId: string, foundIn: string}}
 */
export function detectUnsupportedSchema(repoRoot) {
  const openspecDir = join(repoRoot, 'openspec');
  if (!existsSync(openspecDir)) return { ok: true };

  const schemasDir = join(openspecDir, 'schemas');
  if (existsSync(schemasDir)) {
    let entries = [];
    try { entries = readdirSync(schemasDir, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      if (BUILTIN_SCHEMA_IDS.includes(entry.name)) continue;
      if (!existsSync(join(schemasDir, entry.name, 'schema.yaml'))) continue;
      return {
        ok: false,
        schemaId: entry.name,
        foundIn: `project-local schema directory (openspec/schemas/${entry.name}/schema.yaml)`,
      };
    }
  }

  const changesDir = join(openspecDir, 'changes');
  if (existsSync(changesDir)) {
    let entries = [];
    try { entries = readdirSync(changesDir, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name === 'archive') continue;
      const perChange = join(changesDir, entry.name, '.openspec.yaml');
      if (!existsSync(perChange)) continue;
      const schema = readTopLevelScalar(readFileSync(perChange, 'utf8'), 'schema');
      if (schema && !BUILTIN_SCHEMA_IDS.includes(schema)) {
        return {
          ok: false,
          schemaId: schema,
          foundIn: `per-change override (openspec/changes/${entry.name}/.openspec.yaml)`,
        };
      }
    }
  }

  const configPath = existsSync(join(openspecDir, 'config.yaml'))
    ? join(openspecDir, 'config.yaml')
    : join(openspecDir, 'config.yml');
  if (existsSync(configPath)) {
    const schema = readTopLevelScalar(readFileSync(configPath, 'utf8'), 'schema');
    if (schema && !BUILTIN_SCHEMA_IDS.includes(schema)) {
      return { ok: false, schemaId: schema, foundIn: `openspec/config.yaml (schema: ${schema})` };
    }
  }

  return { ok: true };
}

/**
 * Build the bilingual (EN then RU), actionable STOP message for an unsupported schema —
 * mirrors `proveOpenspec`'s "nothing was written" pattern (src/config.mjs:150-157): names the
 * schema, says exactly where it was found, states plainly that custom schemas are not yet
 * supported, and points at the deferred follow-up.
 * @param {{schemaId: string, foundIn: string}} detection
 * @returns {string}
 */
export function buildSchemaGateError(detection) {
  const en = `✗ Unsupported OpenSpec schema '${detection.schemaId}' found in: ${detection.foundIn}. `
    + `serpens-sdd only supports the built-in 'spec-driven' schema (proposal, specs, design, `
    + `tasks) — project-local custom schemas are not yet supported. This is tracked as a `
    + `follow-up (real mapping-file support, deferred; see `
    + `spec-skipspecs-and-custom-schemas-2026-09-11.md item 4b). Nothing was written.`;
  const ru = `✗ Обнаружена неподдерживаемая схема OpenSpec '${detection.schemaId}', найдена в: `
    + `${detection.foundIn}. serpens-sdd поддерживает только встроенную схему 'spec-driven' `
    + `(proposal, specs, design, tasks) — пользовательские схемы проекта пока не поддерживаются. `
    + `Это отслеживается как отдельная задача (полноценная поддержка через файл сопоставления `
    + `схем, отложена; см. spec-skipspecs-and-custom-schemas-2026-09-11.md, пункт 4b). Ничего не записано.`;
  return `${en}\n${ru}`;
}
