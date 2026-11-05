// One-line JSON logger, never logs secrets — see plan-impl.md §10.1
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// Defense in depth: these keys are never written, even if a caller passes them.
const BLOCKED = new Set([
  'token', 'hostToken', 'name', 'funFact', 'assignedTo', 'assignedName', 'assignedFunFact', 'body',
]);

export function createLogger(level = 'info', write = (line) => process.stdout.write(line + '\n')) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const make = (lvl) => (ev, fields = {}) => {
    if (LEVELS[lvl] < threshold) return;
    const out = { t: new Date().toISOString(), lvl, ev };
    for (const [k, v] of Object.entries(fields)) {
      if (BLOCKED.has(k) || k === 't' || k === 'lvl' || k === 'ev') continue;
      if (k === 'err') {
        out.message = v instanceof Error ? v.message : String(v);
        if (v instanceof Error) out.stack = v.stack;
      } else {
        out[k] = v;
      }
    }
    write(JSON.stringify(out));
  };
  return { debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error') };
}

const noop = () => {};
export const silentLog = Object.freeze({ debug: noop, info: noop, warn: noop, error: noop });
