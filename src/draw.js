// Uniform single-cycle assignment (pure) — see plan-impl.md §5.3
/**
 * Seat everyone in a uniformly random circle (Fisher–Yates), then each person
 * gives to the next one. Every n-cycle comes from exactly n rotations of the
 * seating, so all (n-1)! cycles are equally likely.
 * @param {readonly string[]} ids  length >= 2
 * @param {(maxExclusive:number)=>number} randomInt
 * @returns {Map<string,string>} giver id -> receiver id
 */
export function assign(ids, randomInt) {
  if (ids.length < 2) throw new RangeError('need at least 2 ids');
  const a = [...ids];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1); // 0 <= j <= i
    [a[i], a[j]] = [a[j], a[i]];
  }
  return new Map(a.map((id, k) => [id, a[(k + 1) % a.length]]));
}
