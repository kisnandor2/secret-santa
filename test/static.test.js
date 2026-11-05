import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const jsDir = path.join(root, 'js');
const jsFiles = fs.readdirSync(jsDir).filter((f) => f.endsWith('.js'));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('public/js has modules', () => {
  assert.ok(jsFiles.length > 0);
});

test('no unsafe DOM sinks in public/js', () => {
  for (const f of jsFiles) {
    const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
      assert.ok(!src.includes(bad), `${f} must not contain ${bad}`);
    }
  }
});

test('index.html is CSP-clean', () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)];
  assert.ok(scripts.length > 0);
  for (const m of scripts) assert.match(m[1], /\bsrc\s*=/, `inline script: ${m[0]}`);
  assert.doesNotMatch(html, /\sstyle\s*=/i, 'inline style attribute');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'inline event handler attribute');
});

test('index.html references main module and vendored confetti', () => {
  assert.match(html, /<script\b[^>]*type="module"[^>]*src="js\/main\.js"|<script\b[^>]*src="js\/main\.js"[^>]*type="module"/);
  assert.match(html, /<script\b[^>]*src="vendor\/confetti\.browser\.min\.js"/);
});

test('every relative import in public/js resolves', () => {
  const re = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  for (const f of jsFiles) {
    const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
    for (const m of src.matchAll(re)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      assert.ok(fs.existsSync(path.resolve(jsDir, spec)), `${f} imports missing ${spec}`);
    }
  }
});
