import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LAYOUT } from './layout.mjs';

// step 7 (gap 6, spec-openspec-coexistence-2026-09-22.md): a small JSON side record of exactly
// which ambiguous-owner writes this install CREATED versus APPENDED, so `serpens-sdd uninstall`
// does not have to guess. An owner check (a marker, a byte-identity check) still gates every
// removal — this record only ever narrows what an owner-check-passed removal does (delete a
// file outright vs. leave a team's surrounding content alone), never substitutes for the check.
// A missing or unreadable record degrades to owner checks alone (see `readInstallRecord`).

/**
 * Read `<root>/serpens/.install-record.json`, or an empty record if it is absent or unreadable.
 * Never throws.
 * @param {string} root
 * @returns {{files: Record<string,'created'|'appended'>}}
 */
export function readInstallRecord(root) {
  const path = join(root, LAYOUT.installRecord);
  if (!existsSync(path)) return { files: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return { files: parsed && typeof parsed.files === 'object' ? parsed.files : {} };
  } catch {
    return { files: {} };
  }
}

/**
 * Merge `{relPath: kind}` into the record on disk, writing it back. `created` is sticky — a
 * second onboarding pass records the same file as `appended` (already present now) but the
 * fact that WE made it exist in the first place must not be lost, so `created` is never
 * downgraded to `appended` for the same path.
 * @param {string} root
 * @param {string} relPath - forward-slash, relative to `root`
 * @param {'created'|'appended'} kind
 */
export function recordInstalledFile(root, relPath, kind) {
  const path = join(root, LAYOUT.installRecord);
  const current = readInstallRecord(root);
  const existingKind = current.files[relPath];
  if (existingKind === 'created') return; // sticky: never downgrade
  current.files[relPath] = kind;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
}
