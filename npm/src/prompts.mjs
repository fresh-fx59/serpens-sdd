import { createInterface } from 'node:readline/promises';

/**
 * Ask a single question on stdin/stdout, showing the default in brackets.
 * The only file in this package allowed to read stdin.
 * @param {{key: string, question: string, default?: string}} input
 * @returns {Promise<string>}
 */
export async function ask(input) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = input.default !== undefined && input.default !== '' ? ` [${input.default}]` : '';
  try {
    const answer = await rl.question(`${input.question}${suffix}: `);
    const trimmed = answer.trim();
    return trimmed.length > 0 ? trimmed : (input.default ?? '');
  } finally {
    rl.close();
  }
}
