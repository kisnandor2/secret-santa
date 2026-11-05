// Identity storage — see plan-impl.md §8.3. Every access is guarded.
const KEY = 'santa.id';

function read(store) {
  try {
    const raw = window[store].getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (v && typeof v.code === 'string' && typeof v.token === 'string') return v;
  } catch { /* unavailable or corrupt */ }
  return null;
}

export function save({ code, token, role, name }) {
  const json = JSON.stringify({ code, token, role, name });
  for (const store of ['sessionStorage', 'localStorage']) {
    try { window[store].setItem(KEY, json); } catch { /* ignore */ }
  }
}
export const loadSession = () => read('sessionStorage');
export const loadRemembered = () => read('localStorage');
export function clear() {
  for (const store of ['sessionStorage', 'localStorage']) {
    try { window[store].removeItem(KEY); } catch { /* ignore */ }
  }
}
