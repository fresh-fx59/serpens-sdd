import { existsSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  declaredReferenceIds, declaredReferences, renameStoreReference, resolveConfigPath,
} from './openspecconfig.mjs';
import { callSiteRoots } from './offline.mjs';

// Registering OUR system store with the local OpenSpec, and never touching the user's.
//
// WHY THIS EXISTS. We already write `references:` into a spoke's `openspec/config.yaml`, but
// OpenSpec builds that shared-spec index only from REGISTERED checkouts
// (`dist/core/references.js`). An unregistered id yields the warning
// `Referenced store 'x' is not registered on this machine` (references.js:287) — and an index
// entry that still carries the store id, so "the index is non-empty" is NOT proof of anything.
// Registration is what makes the key we already write do something.
//
// THE ONE FACT THAT SHAPES THIS WHOLE MODULE. The committed metadata id does NOT lose to
// `--id`. `dist/core/store/operations.js:487-497`:
//
//     if (metadata && explicitId !== undefined && metadata.id !== explicitId)
//         throw new StoreError(..., 'store_metadata_id_mismatch', ...)
//
// So passing `--id <ours>` at a store whose committed `.openspec-store/store.yaml` says
// something else FAILS THE CALL OUTRIGHT. We therefore read that file OURSELVES first and adopt
// its id before any `openspec store` call, and we never pass a competing `--id`.
//
// And adoption is all-or-nothing. A run that adopts the committed id in memory but leaves the
// serpens config file — or a `references:` entry a previous run already wrote — naming the old
// id produces a spoke that resolves to `unknown_store`, or, worse, to a DIFFERENT registered
// store holding that id (`dist/core/root-selection.js`). Partial adoption is not an outcome we
// ship: if any half of it cannot be completed, the run fails — and because a run CAN be killed
// between the halves, a re-run decides what is left to do from the state of the reference entries
// on disk, never from the config's own id field (see `staleReferenceIds`). Every config file this
// module rewrites is replaced atomically, so no crash can leave a half-written one.

/** `<storeRoot>/.openspec-store/store.yaml` — the versioned half of a store's identity. */
export const STORE_METADATA_PATH = join('.openspec-store', 'store.yaml');

/**
 * The only `.openspec-store/store.yaml` schema version this package understands.
 *
 * Upstream pins it with `z.literal(1)` (`dist/core/store/foundation.js`, `MetadataStateSchema`)
 * and any other value fails the whole store operation with `invalid_store_metadata`
 * (`operations.js:42`). Reading the id out of a file whose version we do not know and ADOPTING
 * it was the worst possible order: the adoption is persisted — the serpens config and every
 * `references:` entry rewritten — and the very next `openspec store register` then rejects the
 * same file, with nothing rolled back. So the version is checked BEFORE the id is used for
 * anything, and an unknown one is a refusal naming the file and the version.
 */
export const SUPPORTED_STORE_METADATA_VERSION = 1;

/**
 * How many times `openspec store register` is retried when the registry lock is held.
 * `dist/core/store/foundation.js:190-192` throws `store_registry_busy` around
 * `<registry>.yaml.lock`, and a clean `store list` does not mean `register` can take the lock a
 * moment later — the two calls are seconds apart and any other OpenSpec process may hold it.
 * Bounded on purpose: three attempts, then a clean failure, never an unbounded wait.
 */
export const REGISTRY_LOCK_ATTEMPTS = 3;
/** Backoff between those attempts, in milliseconds (attempt n waits DELAY * n). */
export const REGISTRY_LOCK_BACKOFF_MS = 250;

/**
 * Read the store id the checkout itself carries, parsing `.openspec-store/store.yaml` by hand.
 *
 * Done ourselves, before any CLI call, because upstream refuses a `--id` that disagrees with
 * this file rather than letting it win (see the module header). Two keys, plain scalars, one per
 * line — this is a file OpenSpec writes, not a user-authored one, so a scan is honest here where
 * it would not be for `openspec/config.yaml`. Anything unparseable is reported, never guessed.
 * @param {string} storeRoot
 * @returns {{present: boolean, id?: string, path: string, error?: string}}
 */
export function readCommittedStoreId(storeRoot) {
  const path = join(storeRoot, STORE_METADATA_PATH);
  if (!existsSync(path)) return { present: false, path };
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { present: true, path, error: `could not read ${path}: ${err.message}` };
  }
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const scalar = (key) => {
    const line = lines.find((l) => new RegExp(`^${key}:\\s*\\S`).test(l));
    if (!line) return null;
    const raw = line.replace(new RegExp(`^${key}:\\s*`), '').trim().replace(/\s+#.*$/, '');
    return (raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))
      ? raw.slice(1, -1)
      : raw;
  };

  // THE VERSION FIRST. Never read an id out of a document whose schema we do not know: upstream
  // will reject the same file with `invalid_store_metadata`, and by then adoption is on disk.
  const version = scalar('version');
  if (version === null) {
    return {
      present: true,
      path,
      error: `${path} declares no 'version:' — this package only understands store metadata `
        + `version ${SUPPORTED_STORE_METADATA_VERSION}, and OpenSpec itself rejects metadata `
        + 'without one (invalid_store_metadata). Refusing to adopt an id from it.',
    };
  }
  if (version !== String(SUPPORTED_STORE_METADATA_VERSION)) {
    return {
      present: true,
      path,
      version,
      error: `${path} declares version ${version}; this package understands store metadata `
        + `version ${SUPPORTED_STORE_METADATA_VERSION} only. OpenSpec would reject it too `
        + '(invalid_store_metadata), so adopting an id from it would leave this install rewritten '
        + 'to an id no `openspec store` call will accept. Nothing was changed.',
    };
  }

  const id = scalar('id');
  if (id === null) {
    return { present: true, path, error: `${path} exists but declares no top-level 'id:' — refusing to guess this store's identity` };
  }
  if (!id) {
    return { present: true, path, error: `${path} declares an empty 'id:'` };
  }
  return { present: true, path, version, id };
}

/**
 * Parse one `--json` document from an `openspec store` call.
 *
 * `--json` failures emit ONE JSON document carrying `status: [{severity, code, message, fix}]`
 * (`dist/commands/shared-output.js`), so the diagnostic is read from that structure, never
 * scraped out of human text. A body that is not JSON at all is its own answer: that is what an
 * OpenSpec with no `store` subcommand produces, and the caller uses it to skip the stage.
 * @param {string} stdout
 * @returns {{json: boolean, payload?: object, error?: {code: string, message: string, fix?: string}}}
 */
export function parseStoreJson(stdout) {
  const text = (stdout || '').trim();
  if (!text.startsWith('{')) return { json: false };
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { json: false };
  }
  const status = Array.isArray(payload.status) ? payload.status : [];
  const failure = status.find((s) => s && s.severity === 'error');
  return failure
    ? { json: true, payload, error: { code: failure.code, message: failure.message, fix: failure.fix } }
    : { json: true, payload };
}

/**
 * The commands this stage would run, printed by `--dry-run`. Derived from the same expressions
 * the real run uses, so the plan cannot describe a call this stage does not make. `--offline`
 * does NOT print this: it executes the registration like any other run (see `registerSystemStore`
 * and src/offline.mjs).
 * @param {{openspec: string, storeRoot: string, storeId: string, committed: object}} opts
 * @returns {string[]}
 */
export function registrationPlan({ openspec, storeRoot, storeId, committed }) {
  const abs = resolve(storeRoot);
  const lines = [];
  lines.push(`  $ ${openspec} store list --json   # detection; a body that is not JSON means no 'store' subcommand → stage skipped`);
  if (committed?.present && committed.id && committed.id !== storeId) {
    lines.push(`  adopt: ${committed.id} (committed in ${STORE_METADATA_PATH}) replaces config id ${storeId}, everywhere, BEFORE registering`);
  }
  const effectiveId = committed?.present && committed.id ? committed.id : storeId;
  lines.push(`  if '${effectiveId}' is registered at another path: refuse, print both paths, change nothing`);
  lines.push('  any other registered store: left completely alone');
  lines.push(
    committed?.present
      ? `  $ ${openspec} store register ${abs} --yes --json   # no --id: the committed metadata id wins and a competing --id throws store_metadata_id_mismatch`
      : `  $ ${openspec} store register ${abs} --id ${effectiveId} --yes --json`,
  );
  lines.push(`  (up to ${REGISTRY_LOCK_ATTEMPTS} attempts while the registry lock is held, then a clean failure)`);
  lines.push(`  if ${STORE_METADATA_PATH} was created: $ git -C ${abs} add -- ${STORE_METADATA_PATH}`);
  lines.push(`  if THAT PATH is staged:  $ git -C ${abs} commit -m '<registration message>' -- ${STORE_METADATA_PATH}   # never the whole index`);
  lines.push('  if that path is not staged: no commit at all');
  lines.push(`  then, on every run, if <base> is ahead of origin/<base>: $ git -C ${abs} push origin <base>`);
  lines.push(`  $ ${openspec} store list --json   # must prove '${effectiveId}' at ${abs}`);
  return lines;
}

const REGISTRATION_COMMIT_MESSAGE = 'chore(serpens-sdd): commit store identity metadata';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Replace a file's content ATOMICALLY: write a sibling temp file, then rename it over the target.
 *
 * `writeFileSync` truncates first and writes second, so a crash — or a full disk — between the
 * two leaves a HALF-WRITTEN `openspec/config.yaml` or serpens config: exactly the silent
 * data loss this package's compatibility claim is about, and a state no re-run can reason about
 * because the file no longer says anything true. `rename(2)` within one directory is atomic, so a
 * reader either sees the old file or the new one, never a fragment.
 * @param {string} path
 * @param {string} text
 */
function writeFileAtomic(path, text) {
  const tmp = join(dirname(path), `.${path.split(/[/\\]/).pop()}.serpens-${process.pid}.tmp`);
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch { /* the temp file is the only thing left to lose; the original is intact */ }
    throw err;
  }
}

/**
 * Rewrite `store.id` in the serpens config FILE the run was given, so adoption survives the
 * process. Nothing to do when `init` was run without `--config`: there is no file to persist to.
 * @param {string|undefined} configPath
 * @param {string} newId
 * @returns {{ok: boolean, changed: boolean, error?: string}}
 */
function persistAdoptedIdToConfigFile(configPath, newId) {
  if (!configPath) return { ok: true, changed: false };
  let parsed;
  let text;
  try {
    text = readFileSync(configPath, 'utf8');
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, changed: false, error: `could not re-read ${configPath} to persist the adopted store id: ${err.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.store || typeof parsed.store !== 'object') {
    // No `store` block to rewrite: the id came from the project-name default, so there is
    // nothing in the file that would contradict the adopted id on a re-run.
    return { ok: true, changed: false };
  }
  if (parsed.store.id === newId) return { ok: true, changed: false };
  parsed.store.id = newId;
  try {
    writeFileAtomic(configPath, `${JSON.stringify(parsed, null, 2)}\n`);
  } catch (err) {
    return { ok: false, changed: false, error: `could not write the adopted store id to ${configPath}: ${err.message}` };
  }
  return { ok: true, changed: true };
}

/**
 * Rewrite every already-written `references:` entry that still names the old id, in the store
 * and in every onboarded repository on disk. A refusal here fails the run: see the module
 * header on why partial adoption is not shippable.
 * @param {{storeRoot: string, oldId: string, newId: string}} opts
 * @returns {{ok: boolean, evidence: string[], error?: string}}
 */
function rewriteWrittenReferences({ storeRoot, oldId, newId }) {
  const evidence = [];
  for (const root of callSiteRoots(storeRoot)) {
    const resolved = resolveConfigPath(root, existsSync);
    if (!resolved.existed) continue;
    const text = readFileSync(resolved.path, 'utf8');
    if (!declaredReferenceIds(text).includes(oldId)) continue;
    const renamed = renameStoreReference(text, oldId, newId);
    if (renamed.action === 'refused') {
      return {
        ok: false,
        evidence,
        error: `${resolved.path} still declares the old store id "${oldId}" under references: and could not be rewritten to "${newId}" — ${renamed.reason}. `
          + 'Adoption is all-or-nothing: a spoke left naming the old id resolves to unknown_store, or to a different store holding that id. '
          + `Fix by hand (${renamed.manual}) and re-run.`,
      };
    }
    if (renamed.action === 'renamed') {
      writeFileAtomic(resolved.path, renamed.text);
      evidence.push(`$ rewrite ${resolved.path}: references: entry "${oldId}" → "${newId}" (${renamed.count}) → done`);
    }
  }
  return { ok: true, evidence };
}

/**
 * The ids that reachable `references:` entries still give to OUR store.
 *
 * WHY THE REFERENCE ENTRIES, AND NOT THE CONFIG'S ID FIELD. Adoption touches two places: the
 * serpens config and every `references:` entry on disk. If the run is interrupted — or, as the
 * reviewer reproduced without any crash at all, if the reference rewrite REFUSES after the config
 * was already written — the two disagree, and a re-run that asks "does the config already name
 * the committed id?" answers yes and repairs nothing, reporting success over a spoke that still
 * resolves to the wrong store. So the repair set is read from the actual entries.
 *
 * An entry is OURS when its `remote:` is this store's remote; that is the only fact on the line
 * that distinguishes a stale entry we wrote from a reference the user declared to some other
 * store. The plain-string form carries no remote and is therefore never claimed here — it is only
 * ever repaired through the old id the config still names.
 * @param {{storeRoot: string, storeRemote?: string, adoptedId: string}} opts
 * @returns {Map<string, string[]>} stale id → the config files that still declare it
 */
function staleReferenceIds({ storeRoot, storeRemote, adoptedId }) {
  const stale = new Map();
  if (!storeRemote) return stale;
  for (const root of callSiteRoots(storeRoot)) {
    const resolved = resolveConfigPath(root, existsSync);
    if (!resolved.existed) continue;
    let text;
    try {
      text = readFileSync(resolved.path, 'utf8');
    } catch {
      continue; // unreadable is not "stale"; the run will fail on it elsewhere if it matters
    }
    for (const entry of declaredReferences(text)) {
      if (entry.id === adoptedId) continue;
      if (entry.remote === undefined || entry.remote !== storeRemote) continue;
      stale.set(entry.id, [...(stale.get(entry.id) ?? []), resolved.path]);
    }
  }
  return stale;
}

/**
 * Register the system store with the local OpenSpec — the stage that makes our `references:`
 * key resolve — without ever touching a registration we did not create.
 *
 * Order is load-bearing and is NOT the order the first draft of the spec gave:
 *   0. detect (`store list --json`); a non-JSON body means this OpenSpec has no `store`
 *      subcommand at all, so the whole stage is skipped and the install still succeeds;
 *   1. ADOPT the committed metadata id, if the checkout carries one that differs from our
 *      config's — in memory, in the config file, and in every `references:` entry already on
 *      disk — BEFORE anything else looks at an id;
 *   2. check for conflicts under the ADOPTED id, and refuse rather than repair someone else's
 *      registration;
 *   3. register, retrying a bounded number of times while the registry lock is held;
 *   4. commit `.openspec-store/store.yaml`, and ONLY that path, when register created it —
 *      upstream never commits it, and it is the versioned half of the identity — then push if the
 *      local base is ahead of `origin/<base>`, on every run, whether or not this one committed;
 *   5. prove it with a second `store list --json`.
 *
 * Every registry mutation goes through the `openspec store` CLI, so upstream's locking and
 * conflict rules apply. `registry.yaml` is never written, edited or deleted by us, and the two
 * destructive `openspec store` subcommands — the one that forgets a registration, and the one
 * that also deletes the folder — are never invoked from anywhere in this package. Both destroy
 * state we did not create. A grep gate in test/store-registration.test.mjs (with a negative
 * control, so the matcher is proven able to fire) keeps either of them out of every shipped file,
 * which is also why neither is written out by name here.
 * @param {{config: object, run: Function, log?: object, dryRun?: boolean,
 *   storeRoot: string, configPath?: string, openspecCmd: string, openspecBaseArgs: string[],
 *   registryAttempts?: number, registryBackoffMs?: number}} ctx
 * @returns {Promise<{ok: boolean, evidence: string[], error?: string, exitCode?: number,
 *   skipped?: string, adoptedId?: string}>}
 */
export async function registerSystemStore(ctx) {
  const {
    config, run, log, storeRoot, configPath, openspecCmd, openspecBaseArgs,
    dryRun = false,
    registryAttempts = REGISTRY_LOCK_ATTEMPTS,
    registryBackoffMs = REGISTRY_LOCK_BACKOFF_MS,
  } = ctx;
  const evidence = [];
  const absoluteStoreRoot = resolve(storeRoot);
  const openspec = [openspecCmd, ...openspecBaseArgs].join(' ');

  const committed = readCommittedStoreId(absoluteStoreRoot);

  // ONLY `--dry-run` plans without executing. `--offline` is a filesystem ASSERTION about the
  // routes generated call sites use (src/offline.mjs: "Nothing here executes anything or touches
  // the network"), not a mode that skips work — and skipping registration under it produced the
  // one outcome this whole step exists to remove: an install that writes `references:` for a
  // store it never registered. Registration is local: `openspec store register` writes the
  // machine's own registry file and the checkout's own metadata, and the push below is guarded by
  // the existence of `origin/<base>`, exactly as stage 4's is.
  if (dryRun) {
    evidence.push('dry-run: store registration would do (nothing below is executed):');
    for (const line of registrationPlan({ openspec, storeRoot: absoluteStoreRoot, storeId: config.store.id, committed })) {
      evidence.push(line);
    }
    return { ok: true, evidence };
  }

  async function step(cmd, args, opts = {}) {
    const result = await run(cmd, args, { log, ...opts });
    evidence.push(`$ ${cmd} ${args.join(' ')} → exit ${result.code}`);
    return result;
  }

  // ---- 0. Detect. ---------------------------------------------------------------------------
  const listed = await step(openspecCmd, [...openspecBaseArgs, 'store', 'list', '--json']);
  const listParsed = parseStoreJson(listed.stdout);
  if (!listParsed.json) {
    // Not a JSON document at all: this OpenSpec has no `store` subcommand (an out-of-window
    // version, or a build without it). Never fail the install over it — the store, the
    // submodule and every command still work; only OpenSpec's own shared-spec index stays empty.
    evidence.push(
      `⚠ ${openspec} store list --json produced no JSON document — this OpenSpec has no 'store' subcommand. `
      + 'Store registration SKIPPED; the install continues. Cross-repo `references:` will not resolve until '
      + 'this machine runs a version that has it.',
    );
    return { ok: true, evidence, skipped: 'no-store-subcommand' };
  }
  if (listParsed.error) {
    return {
      ok: false, evidence,
      error: `${openspec} store list --json failed [${listParsed.error.code}]: ${listParsed.error.message}`
        + (listParsed.error.fix ? `\n  ↳ upstream fix: ${listParsed.error.fix}` : ''),
      exitCode: 1,
    };
  }
  const registered = Array.isArray(listParsed.payload?.stores) ? listParsed.payload.stores : [];
  evidence.push(
    registered.length === 0
      ? 'registry: no stores registered on this machine'
      : `registry: ${registered.length} store(s) already registered — ${registered.map((s) => `${s.id} ${s.root}`).join('; ')}`,
  );

  // ---- 1. Adopt the committed id, completely, before anything else looks at an id. -----------
  if (committed.error) {
    return { ok: false, evidence, error: committed.error, exitCode: 1 };
  }
  let storeId = config.store.id;
  let adoptedId;
  if (committed.present && committed.id) {
    const target = committed.id;
    // The repair set is the ACTUAL state of the reference entries on disk, plus the config's id
    // when that still disagrees — never the config's id alone. A run that adopted the id in the
    // config and then failed (or refused) on a reference entry leaves the two halves disagreeing,
    // and a condition that only looks at the config field skips the repair and reports success
    // over a spoke still naming the old id. See `staleReferenceIds`.
    const stale = staleReferenceIds({
      storeRoot: absoluteStoreRoot, storeRemote: config.store?.remote, adoptedId: target,
    });
    if (storeId !== target) stale.set(storeId, stale.get(storeId) ?? []);
    if (stale.size > 0) {
      if (storeId !== target) {
        evidence.push(
          `⚠ ADOPTING the committed store id: ${committed.path} says "${target}", this install's config says "${storeId}". `
          + 'The committed id is the shared, versioned fact and upstream refuses a --id that disagrees with it '
          + `(store_metadata_id_mismatch), so "${target}" is used everywhere from here on.`,
        );
      } else {
        evidence.push(
          `⚠ FINISHING A PARTIAL ADOPTION: this config already names "${target}", but reference entries pointing at `
          + `${config.store?.remote} still name ${[...stale.keys()].map((k) => `"${k}"`).join(', ')} `
          + `(${[...new Set([...stale.values()].flat())].join(', ')}). A half-adopted id resolves to unknown_store, `
          + 'or to a different store holding it, so it is completed now.',
        );
      }
      config.store.id = target;
      // REFERENCES FIRST, the serpens config LAST. The config's id is what a re-run would compare
      // against if it trusted that field, so advancing it before the entries are done is the
      // ordering that creates an unrepairable state; this way an interruption always leaves work
      // the next run can still see.
      for (const oldId of stale.keys()) {
        const rewritten = rewriteWrittenReferences({ storeRoot: absoluteStoreRoot, oldId, newId: target });
        evidence.push(...rewritten.evidence);
        if (!rewritten.ok) {
          config.store.id = storeId;
          return { ok: false, evidence, error: rewritten.error, exitCode: 1 };
        }
      }
      const persisted = persistAdoptedIdToConfigFile(configPath, target);
      if (!persisted.ok) {
        config.store.id = storeId;
        return { ok: false, evidence, error: persisted.error, exitCode: 1 };
      }
      if (persisted.changed) evidence.push(`$ rewrite ${configPath}: store.id "${storeId}" → "${target}" → done`);
      adoptedId = target;
      storeId = target;
    }
  }

  // ---- 2. Conflict check, under the adopted id. ---------------------------------------------
  // Paths are compared CANONICALLY. OpenSpec stores what
  // `FileSystemUtils.canonicalizeExistingPath` returns, and on macOS every temp path (and any
  // path through a symlinked home) comes back with its symlinks resolved — `/var/...` becomes
  // `/private/var/...`. A plain `resolve()` comparison therefore reports "not registered" for a
  // store that IS registered, and the run would try to register it a second time.
  const canonical = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const samePath = (a, b) => canonical(a) === canonical(b);
  const ours = registered.find((s) => s.id === storeId && samePath(s.root, absoluteStoreRoot));
  const idElsewhere = registered.find((s) => s.id === storeId && !samePath(s.root, absoluteStoreRoot));
  const pathAsOther = registered.find((s) => s.id !== storeId && samePath(s.root, absoluteStoreRoot));
  for (const other of registered) {
    if (other === ours || other === idElsewhere || other === pathAsOther) continue;
    evidence.push(`preserved, untouched: store "${other.id}" at ${other.root} is not ours and is left exactly as it is`);
  }
  if (idElsewhere) {
    return {
      ok: false, evidence,
      error: `store id "${storeId}" is already registered on this machine at a DIFFERENT path.\n`
        + `  registered: ${idElsewhere.root}\n`
        + `  ours:       ${absoluteStoreRoot}\n`
        + 'One checkout per store id is upstream\'s rule, and that registration is the user\'s — serpens-sdd will not '
        + 'take it over or delete it.\n'
        + `  ↳ your options: point store.id at a different id, point store.root at ${idElsewhere.root}, or resolve it yourself — `
        + `\`openspec store doctor ${storeId}\` prints upstream's own remedy for this exact case.`,
      exitCode: 1,
    };
  }
  if (pathAsOther) {
    return {
      ok: false, evidence,
      error: `${absoluteStoreRoot} is already registered under a different store id "${pathAsOther.id}", and ours is "${storeId}".\n`
        + `  ↳ upstream fix: Use the existing '${pathAsOther.id}' registration or choose a different path.`,
      exitCode: 1,
    };
  }

  // ---- 3. Register (bounded retry while the registry lock is held). --------------------------
  if (ours) {
    evidence.push(`store "${storeId}" is already registered at ${absoluteStoreRoot} — no second registration`);
  } else {
    // NEVER a competing --id: when the checkout carries committed metadata, upstream throws
    // store_metadata_id_mismatch for any --id that differs, and the id we would pass is now the
    // committed one anyway. Omitting it lets upstream read the same file we did.
    const registerArgs = [...openspecBaseArgs, 'store', 'register', absoluteStoreRoot];
    if (!committed.present) registerArgs.push('--id', storeId);
    // `--yes` is REQUIRED non-interactively: without it upstream throws
    // store_register_identity_confirmation_required (operations.js:499) for a root that has no
    // identity metadata yet.
    registerArgs.push('--yes', '--json');

    let last = null;
    for (let attempt = 1; attempt <= registryAttempts; attempt += 1) {
      const result = await step(openspecCmd, registerArgs);
      const parsed = parseStoreJson(result.stdout);
      if (result.code === 0 && parsed.json && !parsed.error) {
        last = { ok: true, parsed };
        break;
      }
      last = { ok: false, result, parsed };
      if (parsed.error?.code === 'store_registry_busy' && attempt < registryAttempts) {
        evidence.push(`registry lock held (store_registry_busy) — attempt ${attempt} of ${registryAttempts}, retrying`);
        await sleep(registryBackoffMs * attempt);
        continue;
      }
      break;
    }
    if (!last.ok) {
      const err = last.parsed?.error;
      return {
        ok: false, evidence,
        error: err
          ? `openspec store register failed [${err.code}]: ${err.message}`
            + (err.fix ? `\n  ↳ upstream fix: ${err.fix}` : '')
            + (err.code === 'store_registry_busy' ? `\n  (${registryAttempts} attempts, all blocked on the registry lock)` : '')
          : `openspec store register failed:\n${last.result.stderr || last.result.stdout}`,
        exitCode: 1,
      };
    }
    const created = Array.isArray(last.parsed.payload?.created_files) ? last.parsed.payload.created_files : [];
    evidence.push(`registered "${storeId}" at ${absoluteStoreRoot}${created.length ? ` (created ${created.join(', ')})` : ''}`);
  }

  // ---- 4. Commit the metadata file. Upstream NEVER commits it (operations.js:525). -----------
  if (existsSync(join(absoluteStoreRoot, STORE_METADATA_PATH))) {
    const isRepo = await step('git', ['-C', absoluteStoreRoot, 'rev-parse', '--is-inside-work-tree']);
    if (isRepo.code === 0) {
      const added = await step('git', ['-C', absoluteStoreRoot, 'add', '--', STORE_METADATA_PATH]);
      if (added.code !== 0) {
        return { ok: false, evidence, error: `could not stage ${STORE_METADATA_PATH}:\n${added.stderr || added.stdout}`, exitCode: 1 };
      }
      // Commit ONLY when something was actually staged — the same discipline stage 4 uses for
      // the submodule registration commit. A re-run on an already-committed store must never
      // produce an empty commit. The staged check and the commit both carry the SAME explicit
      // pathspec: `git commit` with no pathspec publishes the whole index, so anything another
      // process happened to stage in this worktree — a half-finished `git add -p`, a concurrent
      // tool — became part of our commit and was pushed to the shared remote under our message.
      // We commit the one file we are responsible for, and nothing else, whatever the index says.
      const cached = await step('git', ['-C', absoluteStoreRoot, 'diff', '--cached', '--name-only', '--', STORE_METADATA_PATH]);
      if ((cached.stdout || '').trim()) {
        const committedResult = await step('git', [
          '-C', absoluteStoreRoot, 'commit', '-m', REGISTRATION_COMMIT_MESSAGE, '--', STORE_METADATA_PATH,
        ]);
        if (committedResult.code !== 0) {
          return { ok: false, evidence, error: `could not commit ${STORE_METADATA_PATH}:\n${committedResult.stderr || committedResult.stdout}`, exitCode: 1 };
        }
        evidence.push(`committed the store identity metadata: ${cached.stdout.trim().split('\n').join(', ')}`);
      } else {
        evidence.push(`${STORE_METADATA_PATH} was already committed — nothing to commit`);
      }

      // THE PUSH IS ITS OWN STEP, and it runs on EVERY run — not only the one that made the
      // commit. repository-state.sh's `prepare-base` refuses a base with unpushed commits
      // ("<base> has N unpushed commit(s)"), so a run whose push failed used to leave a state no
      // re-run could repair: the commit was already there, so the re-run took the
      // "nothing to commit" branch and never pushed again, and the next full `init` then died
      // earlier, on the gate. The condition is therefore the state on disk — is the local base
      // ahead of origin/<base>? — not what this particular run happened to do.
      const base = config?.store?.base_branch;
      const hasUpstream = base
        ? await step('git', ['-C', absoluteStoreRoot, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`])
        : null;
      if (base && hasUpstream && hasUpstream.code === 0) {
        const ahead = await step('git', ['-C', absoluteStoreRoot, 'rev-list', '--count', `origin/${base}..${base}`]);
        const unpushed = ahead.code === 0 ? Number.parseInt((ahead.stdout || '').trim(), 10) : NaN;
        if (Number.isNaN(unpushed)) {
          return {
            ok: false, evidence,
            error: `could not tell whether ${base} is ahead of origin/${base} in ${absoluteStoreRoot}:\n${ahead.stderr || ahead.stdout}`,
            exitCode: 1,
          };
        }
        if (unpushed > 0) {
          const pushed = await step('git', ['-C', absoluteStoreRoot, 'push', 'origin', base]);
          if (pushed.code !== 0) {
            return {
              ok: false, evidence,
              error: `could not push the store identity commit to origin/${base}:\n${pushed.stderr || pushed.stdout}`,
              exitCode: 1,
            };
          }
          evidence.push(`pushed ${unpushed} unpushed commit(s) on ${base} to origin/${base}`);
        } else {
          evidence.push(`origin/${base} already has every local commit on ${base} — nothing to push`);
        }
      } else {
        // A brand-new store built from the template has no origin/<base> yet, so there is
        // nothing to push to and `prepare-base` is not run against it either. Say so rather
        // than failing on a push that cannot succeed.
        evidence.push(`origin/${base ?? '(no base_branch)'} does not exist yet — the identity commit stays local until the store is first pushed`);
      }
    } else {
      evidence.push(`${absoluteStoreRoot} is not a git worktree — ${STORE_METADATA_PATH} left uncommitted`);
    }
  }

  // ---- 5. Prove it. -------------------------------------------------------------------------
  const proof = await step(openspecCmd, [...openspecBaseArgs, 'store', 'list', '--json']);
  const proofParsed = parseStoreJson(proof.stdout);
  const proven = proofParsed.json && !proofParsed.error
    && (proofParsed.payload?.stores ?? []).some((s) => s.id === storeId && samePath(s.root, absoluteStoreRoot));
  if (!proven) {
    return {
      ok: false, evidence,
      error: `openspec store list --json did not prove "${storeId}" at "${absoluteStoreRoot}":\n${proof.stdout || proof.stderr}`,
      exitCode: 1,
    };
  }
  evidence.push(`store proven registered: ${storeId} ${absoluteStoreRoot}`);

  return { ok: true, evidence, ...(adoptedId ? { adoptedId } : {}) };
}
