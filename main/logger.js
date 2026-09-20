'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const DEDUPE_WINDOW_MS = 5000;

function formatArg(arg) {
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function createLogger({ isDev = false, sink = console } = {}) {
  const threshold = isDev ? LEVELS.debug : LEVELS.warn;
  const recent = new Map();

  function shouldEmit(level, key, now) {
    const entry = recent.get(key);
    if (entry && now - entry.at < DEDUPE_WINDOW_MS) {
      entry.suppressed += 1;
      return { emit: false };
    }
    const suppressed = entry ? entry.suppressed : 0;
    recent.set(key, { at: now, suppressed: 0 });
    if (recent.size > 200) {
      const oldest = recent.keys().next().value;
      recent.delete(oldest);
    }
    return { emit: true, suppressed };
  }

  function write(level, scope, args) {
    if (LEVELS[level] < threshold) return;
    const text = args.map(formatArg).join(' ');
    const key = `${level}|${scope}|${text}`;
    const decision = shouldEmit(level, key, Date.now());
    if (!decision.emit) return;
    const suffix = decision.suppressed > 0 ? ` (+${decision.suppressed} similar)` : '';
    const method = level === 'debug' ? 'log' : level;
    sink[method](`[${scope}] ${text}${suffix}`);
  }

  return {
    debug: (scope, ...args) => write('debug', scope, args),
    info: (scope, ...args) => write('info', scope, args),
    warn: (scope, ...args) => write('warn', scope, args),
    error: (scope, ...args) => write('error', scope, args)
  };
}

module.exports = { createLogger };
