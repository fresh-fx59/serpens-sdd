import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const kitPath = (lang) => fileURLToPath(new URL(`../kits/${lang}/`, import.meta.url)).replace(/\/$/, '');

export function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(relative(base, p));
  }
  return out;
}

export const kitFileList = (lang) => walk(kitPath(lang)).filter(f => f !== 'MANIFEST.sha256');

const MANIFEST_LINE = /^([0-9a-f]{64})  (.+)$/;

export function verifyManifest(kitDir) {
  const manifest = readFileSync(join(kitDir, 'MANIFEST.sha256'), 'utf8');
  const mismatches = [];
  for (const line of manifest.split('\n').filter(Boolean)) {
    const m = MANIFEST_LINE.exec(line);
    if (!m) {
      mismatches.push(`${line}: unparsable manifest line`);
      continue;
    }
    const [, want, path] = m;
    let got = '';
    try {
      got = createHash('sha256').update(readFileSync(join(kitDir, path))).digest('hex');
    } catch {
      mismatches.push(`${path}: missing`);
      continue;
    }
    if (got !== want) mismatches.push(`${path}: ${got} != ${want}`);
  }
  return { ok: mismatches.length === 0, mismatches };
}
