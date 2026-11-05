// test/helpers/rng.js — deterministic randomInt for reproducible draws
export function seededRandomInt(seed) {
  let s = seed >>> 0;
  const next = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
  return (max) => Math.floor(next() * max);
}
