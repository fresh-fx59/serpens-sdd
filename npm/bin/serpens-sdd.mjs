#!/usr/bin/env node
import { buildCommandTable } from '../src/cli/tools.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const COMMANDS = { ...buildCommandTable(), init: 'init.mjs' };
if (!cmd || cmd === '--help' || cmd === '-h') { await dispatch('help', []); }
else if (COMMANDS[cmd]) { await dispatch(cmd, rest); }
else { console.error(`✗ unknown command "${cmd}" — run \`serpens-sdd help\``); process.exit(2); }

async function dispatch(name, argv) {
  const mod = await import(new URL(`../src/cli/${COMMANDS[name]}`, import.meta.url));
  process.exit(await mod.default(argv, name) ?? 0);
}
