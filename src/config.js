// Env -> frozen config object — see plan-impl.md §3
const INTS = {
  PORT: 3000,
  SESSION_TTL_MIN: 120,
  MAX_SESSIONS: 20,
  MAX_PARTICIPANTS: 50,
  HEARTBEAT_MS: 30000,
  AUTH_TIMEOUT_MS: 5000,
};
const LEVELS = ['debug', 'info', 'warn', 'error'];

function parseInteger(key, raw, min, max) {
  const s = String(raw).trim();
  const n = Number(s);
  if (!/^\d+$/.test(s) || !Number.isSafeInteger(n) || n < min || n > max) {
    const range = max === Infinity ? `an integer >= ${min}` : `an integer from ${min} to ${max}`;
    throw new Error(`Invalid ${key}: ${JSON.stringify(raw)} (must be ${range})`);
  }
  return n;
}

export function loadConfig(env = process.env) {
  const cfg = {};
  for (const [key, dflt] of Object.entries(INTS)) {
    cfg[key] = env[key] === undefined
      ? dflt
      : key === 'PORT' ? parseInteger(key, env[key], 0, 65535) : parseInteger(key, env[key], 1, Infinity);
  }
  const level = env.LOG_LEVEL ?? 'info';
  if (!LEVELS.includes(level)) {
    throw new Error(`Invalid LOG_LEVEL: ${JSON.stringify(level)} (must be one of ${LEVELS.join(', ')})`);
  }
  cfg.LOG_LEVEL = level;

  // Unset means persistence is disabled: sessions live in memory only, as before.
  cfg.DB_PATH = env.DB_PATH ? String(env.DB_PATH) : null;

  return Object.freeze(cfg);
}
