import { config } from './config.js';
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? 20;
function fmt(level, scope, msg, extra) {
  const ts = new Date().toISOString();
  const base = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  return extra === undefined ? base : `${base} ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
}
export function logger(scope) {
  const out = (level, msg, extra) => {
    if (LEVELS[level] < threshold) return;
    const line = fmt(level, scope, msg, extra);
    (level === 'error' || level === 'warn' ? console.error : console.log)(line);
  };
  return {
    debug: (m, e) => out('debug', m, e),
    info: (m, e) => out('info', m, e),
    warn: (m, e) => out('warn', m, e),
    error: (m, e) => out('error', m, e),
  };
}
