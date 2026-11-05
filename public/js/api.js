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
