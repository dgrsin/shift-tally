// Central configuration. Reads .env (if present) then process.env.
import fs from 'node:fs';
import path from 'node:path';

function loadDotEnv(file = '.env') {
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      const hash = val.indexOf(' #');
      if (hash >= 0) val = val.slice(0, hash).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch { /* no .env */ }
}
loadDotEnv();

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const num = (k, d) => Number(env(k, d));
const bool = (k, d) => String(env(k, d)).toLowerCase() === 'true';

export const config = {
  tz: env('TZ', 'Asia/Seoul'),
  logLevel: env('LOG_LEVEL', 'info'),
  dbPath: path.resolve(env('DB_PATH', './data/living.db')),

  llm: {
    provider: env('LLM_PROVIDER', 'claude'), // claude | mock
    model: env('LLM_MODEL', 'claude-opus-5-5'),
    fallbacks: env('LLM_FALLBACKS', 'default'), // default | off
    effort: env('LLM_EFFORT', 'medium'),
    maxTokens: num('LLM_MAX_TOKENS', 8000),
  },

  telegram: {
    botToken: env('TELEGRAM_BOT_TOKEN', ''),
    allowedChatId: env('ALLOWED_CHAT_ID', ''),
    adminBotToken: env('ADMIN_BOT_TOKEN', ''),
    adminChatIds: env('ADMIN_CHAT_IDS', '').split(',').map((s) => s.trim()).filter(Boolean),
    transport: env('TELEGRAM_TRANSPORT', 'real'), // real | mock
    pollTimeoutSec: num('TELEGRAM_POLL_TIMEOUT_SEC', 25),
  },

  admin: {
    port: num('ADMIN_PORT', 8787),
    token: env('ADMIN_TOKEN', ''),
    url: env('ADMIN_URL', 'http://127.0.0.1:8787'),
  },

  sim: {
    tickIntervalSec: num('TICK_INTERVAL_SEC', 120),
    schedulerPollSec: num('SCHEDULER_POLL_SEC', 5),
    fixedEventOffsetMin: num('FIXED_EVENT_OFFSET_MIN', 120),
    allowFastForward: bool('ALLOW_FAST_FORWARD', 'true'),
    inboundDebounceMs: num('INBOUND_DEBOUNCE_MS', 6000),
    // how often the sister "checks in with herself" when nothing new happened
    idleDeliberationMinPre: num('IDLE_DELIBERATION_MIN_PRE', 40),
    idleDeliberationMinPost: num('IDLE_DELIBERATION_MIN_POST', 12),
    // how often the world engine advances non-fixed developments after the accident
    worldAdvanceMinPost: num('WORLD_ADVANCE_MIN_POST', 10),
    postAccidentHoursMin: num('POST_ACCIDENT_HOURS_MIN', 3),
  },
};

export function validateRuntimeConfig() {
  const problems = [];
  if (config.llm.provider === 'claude' && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    problems.push('ANTHROPIC_API_KEY is not set (or set LLM_PROVIDER=mock for a dry run)');
  }
  if (config.telegram.transport === 'real') {
    if (!config.telegram.botToken) problems.push('TELEGRAM_BOT_TOKEN is not set (or set TELEGRAM_TRANSPORT=mock)');
    if (!config.telegram.allowedChatId) problems.push('ALLOWED_CHAT_ID is not set — the character bot refuses to message anyone until it is');
  }
  if (!config.admin.token) problems.push('ADMIN_TOKEN is not set — admin HTTP API will refuse all requests');
  return problems;
}
