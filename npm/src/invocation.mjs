/**
 * Split a configured invocation string (e.g. `config.openspec.invocation`, or the resolved
 * call-route invocation a lefthook config embeds) into an executable {cmd, args}. Shared by
 * every stage that runs a configurable external command rather than a packaged one.
 * @param {string} invocation
 * @returns {{cmd: string, args: string[]}}
 */
export function splitInvocation(invocation) {
  const parts = (invocation || '').split(/\s+/).filter(Boolean);
  return { cmd: parts[0], args: parts.slice(1) };
}
