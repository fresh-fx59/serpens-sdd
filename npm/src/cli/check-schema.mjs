// check-schema.mjs — `serpens-sdd check-schema`: the shared entry precondition every kit
// workflow command (spns-spec, spns-plan, spns-implement, spns-archive) runs FIRST, so an
// already-installed project also gets caught if its OpenSpec schema changes to an unsupported
// one AFTER install (stage0-prereqs.mjs only catches it at `init` time). Same detection
// (src/schemagate.mjs), same bilingual message, exit 0 when the schema in effect is supported.
import { detectUnsupportedSchema, buildSchemaGateError } from '../schemagate.mjs';
import { findGitRoot } from './tools.mjs';

/**
 * @param {string[]} argv - `[--repo-root <path>]`, defaulting to the git root of `cwd`
 * @returns {Promise<number>} 0 when the schema in effect is supported, 3 when it is not
 */
export default async function main(argv) {
  const flagIdx = argv.indexOf('--repo-root');
  const repoRoot = flagIdx !== -1 && argv[flagIdx + 1] ? argv[flagIdx + 1] : findGitRoot(process.cwd());

  const detection = detectUnsupportedSchema(repoRoot);
  if (!detection.ok) {
    process.stderr.write(`${buildSchemaGateError(detection)}\n`);
    return 3;
  }
  process.stdout.write('✓ OpenSpec schema in effect is supported (spec-driven)\n');
  return 0;
}
