import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CAPTURE_LIMIT = 4000;

/**
 * Truncate a captured stream so one runaway command cannot bloat the run log, and SAY it was
 * truncated (with the real length) rather than silently dropping the tail.
 * @param {string} text
 * @returns {string}
 */
export function truncateCapture(text, limit = CAPTURE_LIMIT) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [truncated: ${text.length} chars captured, first ${limit} logged]`;
}

/** Indent a multi-line capture so it never looks like a new `$ cmd` line in the log. */
function indentCapture(text) {
  return text.replace(/\n/g, '\n      ');
}

/**
 * Create a log that appends lines with ISO timestamp prefixes.
 * @param {string} path - File path to append logs to
 * @returns {{line(msg: string), record(result: object), close()}}
 */
export function createLog(path) {
  let logWriteErrorReported = false;

  const safeAppend = (msg) => {
    try {
      const iso = new Date().toISOString();
      appendFileSync(path, `${iso} ${msg}\n`, 'utf8');
    } catch (err) {
      if (!logWriteErrorReported) {
        process.stderr.write(`Warning: could not write to log ${path}: ${err.message}\n`);
        logWriteErrorReported = true;
      }
    }
  };

  return {
    line(msg) {
      safeAppend(msg);
    },
    record(result) {
      // Format a run result: "→ exit N" for normal runs, "→ (dry-run, not executed)" for dry
      // runs. The `$ cmd args` / `→ exit N` line pair is kept exactly as it was so anything
      // grepping the log keeps working; the captured output is appended AFTER it, one
      // indented block per stream, because spec §13 promises the log holds every command, its
      // exit code AND its captured output.
      const formatted = result.dryRun
        ? '→ (dry-run, not executed)'
        : `→ exit ${result.code}`;
      safeAppend(formatted);
      if (result.dryRun) return;
      for (const [name, text] of [['stdout', result.stdout], ['stderr', result.stderr]]) {
        if (typeof text !== 'string' || text === '') continue;
        safeAppend(`    ${name}: ${indentCapture(truncateCapture(text))}`);
      }
    },
    close() {
      // No-op for now, but allows cleanup if needed in the future
    },
  };
}

/**
 * Run a command with optional logging.
 * @param {string} cmd - Command to execute
 * @param {string[]} args - Arguments to pass
 * @param {{log?: object, dryRun?: boolean, cwd?: string, env?: object, timeout?: number,
 *   input?: string}} opts - Options. `input`, when given, is written to the child's stdin and
 *   the stream is then closed; with no `input` stdin is closed immediately (so a child that
 *   reads to EOF, like `sync-submodules.sh --repos-from -`, never hangs waiting for it).
 * @returns {Promise<{code: number, stdout: string, stderr: string, dryRun?: boolean, timedOut?: boolean}>}
 */
export async function run(cmd, args, opts = {}) {
  const { log, dryRun = false, cwd, env, timeout, input } = opts;

  // Format command for logging
  const cmdLine = `$ ${cmd} ${args.join(' ')}`;

  if (log) {
    log.line(cmdLine);
  }

  if (dryRun) {
    const result = {
      code: 0,
      stdout: '',
      stderr: '',
      dryRun: true,
    };
    if (log) {
      log.record(result);
    }
    return result;
  }

  try {
    const promise = execFileAsync(cmd, args, {
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
      cwd,
      env,
      ...(timeout ? { timeout, killSignal: 'SIGKILL' } : {}),
    });
    // util.promisify's built-in custom promisifier for child_process.execFile attaches the
    // real ChildProcess to the returned promise as `.child` — this is what lets us feed its
    // stdin without abandoning the execFile/promisify plumbing everything else here relies on.
    // Stdin is ALWAYS closed (with the given input written first, when there is one): the
    // default pipe stdio otherwise stays open forever, and a child that reads until EOF (like
    // `cat`, or `sync-submodules.sh --repos-from -`) hangs the whole run indefinitely.
    if (promise.child && promise.child.stdin) {
      promise.child.stdin.end(typeof input === 'string' ? input : undefined);
    }
    const result = await promise;

    // A resolved execFile call means exit code 0
    const code = 0;
    if (log) {
      log.record({ code, stdout: result.stdout || '', stderr: result.stderr || '' });
    }

    return {
      code,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  } catch (err) {
    // execFile throws on non-zero exit and spawn failures
    // err.code is the exit code (number) or error code (string like 'ENOENT')
    const code = typeof err.code === 'number' ? err.code : 1;
    const stdout = err.stdout || '';
    const stderr = err.stderr || '';
    const timedOut = err.killed === true && err.signal === 'SIGKILL';

    if (log) {
      log.record({ code, stdout, stderr });
    }

    return {
      code,
      stdout,
      stderr,
      ...(timedOut ? { timedOut: true } : {}),
    };
  }
}
