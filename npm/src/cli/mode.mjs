// mode.mjs — `serpens-sdd mode`: prints `unattended` iff the environment variable
// SERPENS_UNATTENDED is exactly `1`, else `attended`. Kit prose (spns-spec steps 1-2) skips the
// analyst interview / WAIT gate ONLY when this prints `unattended`; the model never decides that
// itself. Unattended runners (the eval harness, CI bots) set the variable explicitly.

/** @param {Record<string, string|undefined>} env */
export function resolveMode(env = process.env) {
  return env.SERPENS_UNATTENDED === '1' ? 'unattended' : 'attended';
}

/** @returns {Promise<number>} always 0 */
export default async function main() {
  process.stdout.write(`${resolveMode()}\n`);
  return 0;
}
