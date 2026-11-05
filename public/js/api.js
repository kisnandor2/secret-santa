// HTTP wrappers — see plan-impl.md §8.1
async function post(path, body) {
  let res;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    const e = new Error("Can't reach the server. Check your connection and try again.");
    e.code = 'NETWORK';
    throw e;
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const e = new Error((data && data.message) || `Something went wrong (${res.status}).`);
    e.code = (data && data.error) || 'HTTP_' + res.status;
    e.status = res.status;
    throw e;
  }
  return data;
}

export const createSession = (body) => post('/api/sessions', body);
export const joinSession = (code, body) =>
  post(`/api/sessions/${encodeURIComponent(String(code).trim())}/join`, body);

// Looks up a closed session's result by the caller's own token. One token,
// one result: never throws, resolves null if there's nothing to find (wrong
// token, session never drawn, session unknown, persistence disabled, or a
// network hiccup) rather than surfacing an error for what is a "maybe" lookup.
export async function getArchivedResult(code, token) {
  try {
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(String(code).trim())}/result?token=${encodeURIComponent(token)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
