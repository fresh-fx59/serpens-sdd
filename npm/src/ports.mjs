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
];

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
