import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORTS_DIR = join(__dirname, '..', 'ports');

export const PORT_FIELDS = [
  'id',
  'label',
  'agent_dir',
  'scope_preference',
  'commands_supported',
  'command_dir',
  'command_layout',
  'command_prefix',
  'command_format',
  'args_token',
  'skills_supported',
  'skill_dir',
  'skill_layout',
  'instruction_file',
  'verified',
  'openspec_tool',
];

/**
 * OpenSpec's own `skillsDir` for a tool id it knows (`@fission-ai/openspec` 1.13.1
 * `dist/core/config.js` AI_TOOLS) — the directory `openspec init --tools <id>` actually writes
 * into, which is not always `.<id>` (e.g. `codex` -> `.agents`). Only the ids this package
 * currently maps a port onto via `openspec_tool` need an entry here; add one whenever a new
 * `openspec_tool` override is introduced.
 */
export const OPENSPEC_TOOL_SKILLS_DIR = {
  qwen: '.qwen',
};

const COMMAND_LAYOUTS = ['flat-prefixed', 'subdir-unprefixed'];
const COMMAND_FORMATS = ['md', 'toml', 'prompt'];
const SKILL_LAYOUTS = ['dir-per-skill'];

function checkString(obj, field, errors) {
  if (typeof obj[field] !== 'string' || obj[field] === '') {
    errors.push(`missing or malformed field: ${field} (expected a non-empty string)`);
  }
}

export function validatePort(obj) {
  const errors = [];
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['port must be an object'] };
  }

  checkString(obj, 'id', errors);
  checkString(obj, 'label', errors);
  checkString(obj, 'agent_dir', errors);
  checkString(obj, 'verified', errors);
  checkString(obj, 'instruction_file', errors);

  if (!Array.isArray(obj.scope_preference) || obj.scope_preference.length === 0) {
    errors.push('missing or malformed field: scope_preference (expected a non-empty array)');
  }

  if (typeof obj.commands_supported !== 'boolean') {
    errors.push('missing or malformed field: commands_supported (expected a boolean)');
  }
  if (typeof obj.skills_supported !== 'boolean') {
    errors.push('missing or malformed field: skills_supported (expected a boolean)');
  }

  if (obj.commands_supported === true) {
    checkString(obj, 'command_dir', errors);
    checkString(obj, 'command_prefix', errors);
    checkString(obj, 'args_token', errors);
    if (!COMMAND_LAYOUTS.includes(obj.command_layout)) {
      errors.push(`missing or malformed field: command_layout (must be one of: ${COMMAND_LAYOUTS.join(', ')})`);
    }
    if (!COMMAND_FORMATS.includes(obj.command_format)) {
      errors.push(`missing or malformed field: command_format (must be one of: ${COMMAND_FORMATS.join(', ')})`);
    }
  }

  if (obj.openspec_tool !== undefined && (typeof obj.openspec_tool !== 'string' || obj.openspec_tool === '')) {
    errors.push('malformed field: openspec_tool (expected a non-empty string when present)');
  }

  if (obj.skills_supported === true) {
    checkString(obj, 'skill_dir', errors);
    if (!SKILL_LAYOUTS.includes(obj.skill_layout)) {
      errors.push(`missing or malformed field: skill_layout (must be one of: ${SKILL_LAYOUTS.join(', ')})`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function parsePortFile(path, raw) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    const err = new Error(`malformed port file ${path}: ${e.message}`);
    err.exitCode = 2;
    throw err;
  }
}

export function listPorts(registryDir = PORTS_DIR) {
  const files = readdirSync(registryDir).filter((f) => f.endsWith('.json'));
  return files.map((f) => {
    const path = join(registryDir, f);
    return parsePortFile(path, readFileSync(path, 'utf8'));
  });
}

export function loadPort({ id, file, registryDir = PORTS_DIR } = {}) {
  const path = file ?? join(registryDir, `${id}.json`);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    const known = listPorts(registryDir)
      .map((p) => p.id)
      .sort()
      .join(', ');
    const err = new Error(`unknown port id "${id}" — known ports: ${known}`);
    err.exitCode = 2;
    throw err;
  }
  const port = parsePortFile(path, raw);
  if (!file && port.id !== id) {
    const err = new Error(`port file ${path} declares id "${port.id}", expected "${id}"`);
    err.exitCode = 2;
    throw err;
  }
  const { ok, errors } = validatePort(port);
  if (!ok) {
    const err = new Error(`invalid port file ${path}: ${errors.join('; ')}`);
    err.exitCode = 2;
    throw err;
  }
  return port;
}

/**
 * The tool id to pass OpenSpec's own `--tools <id>` flag for this port.
 *
 * Most ports' id IS the id OpenSpec's own AI_TOOLS registry knows (verified against
 * `@fission-ai/openspec` 1.13.1 `dist/core/config.js`) — `--tools <port.id>` just works. A few
 * ports are forks/rebrands OpenSpec has never heard of (GigaCode, a fork of Qwen Code): for
 * those the port file carries an explicit `openspec_tool` override naming the OpenSpec tool id
 * whose generated files get relocated afterwards (see src/openspec-tool-relocate.mjs). Absent the
 * override, the port id is used as-is, unchanged from before this field existed.
 * @param {object} port - a loaded, validated port object
 * @returns {string|undefined}
 */
export function openspecToolId(port) {
  return port?.openspec_tool ?? port?.id;
}

/**
 * True when this port needs OpenSpec's output relocated after the fact — i.e. OpenSpec was
 * asked for a DIFFERENT tool id than the port's own `agent_dir` implies.
 * @param {object} port
 * @returns {boolean}
 */
export function needsOpenspecRelocation(port) {
  return Boolean(port?.openspec_tool) && port.openspec_tool !== port.id;
}
