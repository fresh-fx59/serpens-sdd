#!/usr/bin/env node
// The body of the fake `openspec` the breadth suite puts on PATH. A REAL FILE, not a string
// built inside another string: the previous version generated this script from a template
// literal, and getting `\n` through two layers of escaping wrong produced a stub that crashed
// with a syntax error — which read exactly like a stage failure. Configuration comes from a JSON
// file named by FAKE_OPENSPEC_CONFIG, so nothing here has to be escaped at all.
//
// It answers `--version`, `init`, and OpenSpec 1.12's REAL `store` contract:
// `store register <path> [--id <id>] --yes --json` and `store list --json`, including the
// committed-metadata rules that make the contract non-obvious
// (`dist/core/store/operations.js:449-530`):
//   - `--id` disagreeing with a committed `.openspec-store/store.yaml` throws
//     `store_metadata_id_mismatch` — the committed id does NOT silently win;
//   - a root with no metadata needs `--yes`, else `store_register_identity_confirmation_required`;
//   - the same id at a different path is `store_id_conflict`; the same path under another id is
//     `store_path_conflict`;
//   - register writes `.openspec-store/store.yaml` and NEVER commits it.
// Registry state is a JSON file inside the fixture's own temp dir, so it can never reach the
// developer's real `~/.local/share/openspec/stores/registry.yaml`.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

const conf = JSON.parse(readFileSync(process.env.FAKE_OPENSPEC_CONFIG, 'utf8'));
const args = process.argv.slice(2);

function readState() {
  try {
    return JSON.parse(readFileSync(conf.registryPath, 'utf8')).stores ?? [];
  } catch {
    return [];
  }
}
function writeState(stores) {
  writeFileSync(conf.registryPath, JSON.stringify({ stores }));
}
function ok(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(0);
}
function fail(code, message, fix) {
  process.stdout.write(`${JSON.stringify({
    store: null,
    registry: null,
    git: null,
    created_files: [],
    status: [{ severity: 'error', code, message, ...(fix ? { fix } : {}) }],
  }, null, 2)}\n`);
  process.exit(1);
}
function metaPath(root) {
  return join(root, '.openspec-store', 'store.yaml');
}
function readMeta(root) {
  if (!existsSync(metaPath(root))) return null;
  const line = readFileSync(metaPath(root), 'utf8').split('\n').find((l) => /^id:\s*\S/.test(l));
  return line ? { id: line.replace(/^id:\s*/, '').trim() } : null;
}

if (args[0] === '--version') {
  process.stdout.write(`${conf.version}\n`);
  process.exit(0);
}

if (args[0] === 'init') {
  mkdirSync(join(process.cwd(), 'openspec', 'specs'), { recursive: true });
  mkdirSync(join(process.cwd(), 'openspec', 'changes'), { recursive: true });
  process.exit(0);
}

if (args[0] === 'store' && conf.supportsStore === false) {
  // Commander's own shape for an unknown command: human text on stderr, no JSON anywhere.
  process.stderr.write("error: unknown command 'store'\n");
  process.exit(1);
}

if (args[0] === 'store' && args[1] === 'list') {
  ok({
    stores: readState().map((r) => ({ id: r.id, root: r.root, metadata_path: metaPath(r.root) })),
    status: [],
  });
}

if (args[0] === 'store' && args[1] === 'register') {
  const rest = args.slice(2);
  const idAt = rest.indexOf('--id');
  const explicitId = idAt === -1 ? undefined : rest[idAt + 1];
  const yes = rest.includes('--yes');
  const positional = rest.filter((a, i) => !a.startsWith('--') && !(idAt !== -1 && i === idAt + 1));
  const root = resolve(positional[0] ?? process.cwd());
  if (!existsSync(root)) fail('store_path_missing', `Store path does not exist: ${root}`);
  if (!existsSync(join(root, 'openspec'))) {
    fail('store_register_root_unhealthy', 'Store register requires an existing healthy OpenSpec root.');
  }
  const meta = readMeta(root);
  if (meta && explicitId !== undefined && meta.id !== explicitId) {
    fail(
      'store_metadata_id_mismatch',
      `Store metadata id '${meta.id}' does not match --id '${explicitId}'. The id comes from the store's committed .openspec-store/store.yaml.`,
      `Use --id ${meta.id} or register a different folder.`,
    );
  }
  const id = meta ? meta.id : (explicitId ?? basename(root));
  if (!meta && !yes) {
    fail(
      'store_register_identity_confirmation_required',
      `Turn this OpenSpec root into store '${id}'?`,
      `Run interactively or pass --yes to create ${metaPath(root)}.`,
    );
  }
  const stores = readState();
  for (const entry of stores) {
    if (entry.id === id && entry.root === root) continue;
    if (entry.id === id) {
      fail(
        'store_id_conflict',
        `Store '${id}' is already registered at ${entry.root}. One checkout per store id is supported on this machine.`,
        `Use the existing registration, or run openspec store unregister ${id} first to switch this id to a different checkout.`,
      );
    }
    if (entry.root === root) {
      fail(
        'store_path_conflict',
        `Store path is already registered as '${entry.id}'.`,
        `Use the existing '${entry.id}' registration or choose a different path.`,
      );
    }
  }
  const createdFiles = [];
  if (!meta) {
    mkdirSync(join(root, '.openspec-store'), { recursive: true });
    writeFileSync(metaPath(root), `version: 1\nid: ${id}\n`, 'utf8');
    createdFiles.push('.openspec-store/store.yaml');
  }
  const already = stores.some((e) => e.id === id && e.root === root);
  if (!already) {
    stores.push({ id, root });
    writeState(stores);
  }
  ok({
    store: { id, root, metadata_path: metaPath(root) },
    registry: { path: conf.registryPath, registered: !already, already_registered: already },
    // Register NEVER commits — committing the metadata file is the installer's job.
    git: { is_repository: existsSync(join(root, '.git')), initialized: false, committed: false },
    created_files: createdFiles,
    status: [],
  });
}

process.stderr.write(`fake openspec: unrecognized args: ${args.join(' ')}\n`);
process.exit(1);
