// Input normalization/validation (pure) — see plan-impl.md §5.1
import { fail } from './errors.js';

const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const CODE = /^[A-Z]{3,10}-\d{3}$/;

const clean = (s) => s.normalize('NFC').replace(/\s+/g, ' ').trim();

function parseText(raw, label, min, max) {
  if (typeof raw !== 'string') fail('INVALID_INPUT', `${label} must be text.`);
  const s = clean(raw);
  if (CONTROL.test(s)) fail('INVALID_INPUT', `${label} contains invalid characters.`);
  const len = [...s].length;
  if (len < min || len > max) {
    fail('INVALID_INPUT', `${label} must be ${min === 0 ? `at most ${max}` : `${min}–${max}`} characters.`);
  }
  return s;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function normalizeCode(raw) {
  if (typeof raw !== 'string') fail('INVALID_INPUT', 'Session code must be text.');
  const code = raw.trim().toUpperCase();
  if (!CODE.test(code)) fail('INVALID_INPUT', 'Session code looks like FROSTY-427.');
  return code;
}

export function parseName(raw) {
  const name = parseText(raw, 'Name', 1, 40);
  return { name, nameKey: name.toLocaleLowerCase('und') };
}

export function parseFunFact(raw) {
  return parseText(raw === undefined ? '' : raw, 'Fun fact', 0, 200);
}

export function parseJoinBody(body) {
  if (!isPlainObject(body)) fail('INVALID_INPUT', 'Request body must be a JSON object.');
  return { ...parseName(body.name), funFact: parseFunFact(body.funFact) };
}

export function parseCreateBody(body) {
  if (!isPlainObject(body)) fail('INVALID_INPUT', 'Request body must be a JSON object.');
  const participate = body.participate === undefined ? true : body.participate;
  if (typeof participate !== 'boolean') fail('INVALID_INPUT', 'participate must be true or false.');
  if (!participate) return { participate: false };
  return { participate: true, ...parseJoinBody(body) };
}
