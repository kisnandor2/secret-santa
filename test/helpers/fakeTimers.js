// Deterministic setTimeout/clearTimeout/now — see plan-impl.md §11.1
export function fakeTimers() {
  let time = 0;
  let seq = 0;
  const timers = new Set();

  const setTimeout = (fn, ms = 0) => {
    const handle = { fn, at: time + ms, seq: seq++, unref() { return handle; } };
    timers.add(handle);
    return handle;
  };
  const clearTimeout = (handle) => { timers.delete(handle); };

  const advance = (ms) => {
    const target = time + ms;
    for (;;) {
      let next = null;
      for (const t of timers) {
        if (t.at <= target && (!next || t.at < next.at || (t.at === next.at && t.seq < next.seq))) next = t;
      }
      if (!next) break;
      timers.delete(next);
      time = Math.max(time, next.at);
      next.fn();
    }
    time = target;
  };

  return { setTimeout, clearTimeout, now: () => time, advance, pending: () => timers.size };
}
