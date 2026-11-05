// Session code, token and id generation — see plan-impl.md §5.2
import crypto from 'node:crypto';

export const WORDS = Object.freeze([
  'FROSTY', 'JINGLE', 'TINSEL', 'COCOA', 'SLEIGH', 'MISTLETOE', 'CAROL', 'HOLLY',
  'SNOWMAN', 'GARLAND', 'WREATH', 'ELF', 'REINDEER', 'CANDLE', 'GINGER', 'NUTCRACKER',
  'STOCKING', 'IVY', 'ANGEL', 'BAUBLE', 'COOKIE', 'FIREPLACE', 'GLITTER', 'MERRY',
  'NOEL', 'PRESENT', 'RIBBON', 'SNOWFLAKE', 'TINSELY', 'WINTER', 'YULE', 'TOYSHOP',
]);

export function createCodeGen(randomInt = crypto.randomInt) {
  return () => `${WORDS[randomInt(WORDS.length)]}-${100 + randomInt(900)}`;
}

export const newToken = () => crypto.randomBytes(16).toString('base64url'); // 128-bit
export const newId = () => crypto.randomUUID();

export function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
