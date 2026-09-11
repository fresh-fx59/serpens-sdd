import { proveOpenspec } from '../config.mjs';
import { splitInvocation } from '../invocation.mjs';
import { SUPPORTED_MINORS } from '../openspecversion.mjs';

// The required tools, their exact version probe, and the floor each must clear. ONE table, read
// by both the real run and `--dry-run`'s plan, so the printed plan cannot drift from what an
// actual run executes.
const REQUIRED_TOOLS = [
  { label: 'git', cmd: 'git', args: ['--version'], floor: [2, 13], floorText: '>= 2.13' },
  { label: 'node', cmd: 'node', args: ['--version'], floor: [18, 0], floorText: '>= 18' },
  { label: 'lefthook', cmd: 'lefthook', args: ['version'] },
];

/**
 * Every command stage 0 would run, in order, derived from REQUIRED_TOOLS plus the resolved
 * OpenSpec invocation and the optional `ctags` probe. Used by `--dry-run` to print the plan.
 * @param {object} config
 * @returns {Array<{cmd: string, args: string[], note: string}>}
 */
export function prereqPlan(config) {
  const { cmd: openspecCmd, args: openspecArgs } = splitInvocation(config?.openspec?.invocation);
  return [
    ...REQUIRED_TOOLS.map((t) => ({
      cmd: t.cmd, args: t.args, note: t.floorText ? `required, ${t.floorText}` : 'required',
    })),
    {
      cmd: openspecCmd,
      args: [...openspecArgs, '--version'],
      note: config?.openspec?.pinned_version
        ? `required, must print ${config.openspec.pinned_version}`
        : `required, must be one of ${SUPPORTED_MINORS.join(', ')}`,
    },
    { cmd: 'ctags', args: ['--version'], note: 'optional; must print "Universal Ctags" or code search is skipped' },
  ];
}

/**
 * Parse "git version X.Y.Z..." (or similar leading-digits output) into [major, minor].
 * @param {string} text
 * @returns {[number, number]|null}
 */
function parseVersionPair(text) {
  const m = /(\d+)\.(\d+)/.exec(text || '');
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

function atLeast(pair, [wantMajor, wantMinor]) {
  if (!pair) return false;
  const [major, minor] = pair;
  return major > wantMajor || (major === wantMajor && minor >= wantMinor);
}

/**
 * Stage 0 — prove the toolchain before anything else (docs/SETUP.md §0).
 * Every required tool that is missing or below its floor is exit 3. `ctags` is the one
 * optional tool: missing, or present but not Universal Ctags (rejected by brand, since
 * `sym:` search dies silently on BSD/Exuberant ctags), only skips code search.
 * @param {{config: object, run: Function, log?: object, dryRun?: boolean}} ctx
 * @returns {Promise<{ok: boolean, evidence: string[], error?: string, exitCode?: number}>}
 */
export async function stage0(ctx) {
  const { config, run, log, dryRun = false } = ctx;
  const evidence = [];

  if (dryRun) {
    evidence.push('dry-run: stage0 would run (and execute nothing now):');
    for (const step of prereqPlan(config)) {
      evidence.push(`  $ ${step.cmd} ${step.args.join(' ')}   # ${step.note}`);
    }
    return { ok: true, evidence };
  }

  const runOpts = { log };

  for (const tool of REQUIRED_TOOLS) {
    const result = await run(tool.cmd, tool.args, runOpts);
    if (result.code !== 0) {
      evidence.push(`${tool.label}: missing`);
      return {
        ok: false,
        evidence,
        error: `${tool.label} is required${tool.floorText ? ` (${tool.floorText})` : ''} but is missing`,
        exitCode: 3,
      };
    }
    if (tool.floor && !atLeast(parseVersionPair(result.stdout), tool.floor)) {
      evidence.push(`${tool.label}: version too old (${result.stdout.trim()})`);
      return { ok: false, evidence, error: `${tool.label} ${tool.floorText} is required`, exitCode: 3 };
    }
    evidence.push(`${tool.label}: ${result.stdout.trim()}`);
  }

  // openspec, proven against the detected version (and the explicit pin, if the config sets one)
  const openspecResult = await proveOpenspec(config, { run: (cmd, args) => run(cmd, args, runOpts) });
  if (!openspecResult.ok) {
    evidence.push(`openspec: ${openspecResult.error}`);
    return { ok: false, evidence, error: openspecResult.error, exitCode: openspecResult.exitCode ?? 3 };
  }
  evidence.push(`openspec: proven at ${config?.openspec?.invocation} (${openspecResult.version?.raw})`);

  // ctags — optional; BSD ctags is rejected by brand, not just by missing feature.
  const ctagsResult = await run('ctags', ['--version'], runOpts);
  if (ctagsResult.code !== 0) {
    evidence.push('code search: skipped (ctags missing)');
  } else if (!/Universal Ctags/.test(ctagsResult.stdout)) {
    evidence.push('code search: skipped (ctags is not Universal Ctags, rejected by brand)');
  } else {
    evidence.push(`ctags: ${ctagsResult.stdout.trim().split('\n')[0]}`);
  }

  return { ok: true, evidence };
}
