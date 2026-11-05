// Browser end-to-end tests — see plan-impl.md §11.5
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer } from '../helpers/server.js';

const XSS_NAME = '<img src=x onerror=window.__xss=1>';
let server;
let browser;
const contexts = [];

async function launch() {
  try {
    return await chromium.launch({ headless: true });
  } catch (e) {
    // Playwright's bundled Chromium may be unavailable (e.g. download blocked); use system Chrome.
    try {
      return await chromium.launch({ headless: true, channel: 'chrome' });
    } catch {
      throw e;
    }
  }
}

before(async () => {
  server = await startTestServer({ MAX_SESSIONS: 1000 });
  browser = await launch();
});

afterEach(async () => {
  while (contexts.length) await contexts.pop().close().catch(() => {});
});

after(async () => {
  await browser?.close();
  await server?.close();
});

/** New isolated context + page, with error collection. */
async function newPerson(label) {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/favicon/i.test(m.text()) || /favicon/i.test(m.location()?.url || '')) return;
    errors.push(`[${label}] console.error: ${m.text()}`);
  });
  page.on('requestfailed', (r) => {
    if (/favicon/i.test(r.url())) return;
    errors.push(`[${label}] requestfailed: ${r.url()}`);
  });
  return { label, context, page, errors };
}

async function hostCreate(host, { participate = true, name = 'Hosty', fact = 'I love tinsel' } = {}) {
  const { page } = host;
  await page.goto(server.base + '/');
  await page.getByRole('button', { name: 'I am the HOST' }).click();
  if (participate) {
    await page.locator('#hc-name').fill(name);
    await page.locator('#hc-fact').fill(fact);
  } else {
    await page.locator('#hc-skip').check();
  }
  await page.getByRole('button', { name: 'Create session' }).click();
  const codeEl = page.locator('.view-host .code');
  await codeEl.waitFor();
  const code = (await codeEl.textContent()).trim();
  assert.match(code, /^[A-Z]+-\d+$/);
  return code;
}

async function join(person, code, name, fact) {
  const { page } = person;
  await page.goto(`${server.base}/?s=${encodeURIComponent(code)}`);
  assert.equal(await page.locator('#jn-code').inputValue(), code, 'join form prefilled with code');
  await page.locator('#jn-name').fill(name);
  await page.locator('#jn-fact').fill(fact);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await page.locator('.view-waiting').waitFor();
  assert.ok((await page.locator('.view-waiting').textContent()).includes('Waiting for the host'));
}

async function hostDraw(host, expectedCount) {
  const { page } = host;
  await page.getByText(`${expectedCount} people joined`).waitFor();
  const drawBtn = page.getByRole('button', { name: 'Draw!', exact: true });
  await drawBtn.waitFor();
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Draw!');
    return b && !b.disabled;
  });
  await drawBtn.click();
  const dlg = page.locator('dialog.dlg');
  await dlg.waitFor({ state: 'visible' });
  await dlg.getByRole('button', { name: 'Draw', exact: true }).click();
  await page.getByText('Draw complete').waitFor();
}

/** Click the gift, return the assigned name. */
async function openGift(person) {
  const { page } = person;
  const gift = page.locator('.view-reveal .gift');
  await gift.waitFor();
  assert.equal(await page.locator('.view-reveal .reveal-result').isVisible(), false, 'box starts closed');
  await gift.click({ force: true }); // gift wobbles forever, so Playwright never sees it as "stable"
  const nameEl = page.locator('.view-reveal .reveal-name');
  await nameEl.waitFor({ state: 'visible' });
  // Confetti (vendored global) draws onto a canvas it appends to <body>.
  await page.locator('body > canvas').first().waitFor({ state: 'attached', timeout: 3000 });
  return (await nameEl.textContent());
}

async function revealHost(host) {
  const { page } = host;
  const nameEl = page.locator('.view-host .reveal-name');
  assert.equal(await nameEl.count(), 0, 'match not in DOM before reveal');
  assert.equal(await page.getByText('You are the Secret Santa for').count(), 0);
  await page.getByRole('button', { name: 'Reveal my match' }).click();
  await nameEl.waitFor({ state: 'visible' });
  return nameEl.textContent();
}

async function assertClean(people) {
  for (const p of people) {
    assert.equal(await p.page.evaluate(() => window.__xss), undefined, `${p.label}: window.__xss undefined`);
    assert.deepEqual(p.errors, [], `${p.label}: no page/console errors`);
  }
}

test('full flow: host + 3 participants, XSS name, draw, reveal, reload', { timeout: 30000 }, async () => {
  const host = await newPerson('host');
  const people = [await newPerson('p1'), await newPerson('p2'), await newPerson('p3')];
  const everyone = [host, ...people];
  const names = ['Hosty', 'Alice', XSS_NAME, 'Carol'];

  const code = await hostCreate(host, { name: names[0] });
  await join(people[0], code, names[1], 'Fact about Alice');
  await join(people[1], code, names[2], 'Fact about the sneaky one');
  await join(people[2], code, names[3], 'Fact about Carol');

  // Host list: 4 cards, XSS name as literal text, no <img>.
  const cards = host.page.locator('.view-host .cards .card');
  await host.page.getByText('4 people joined').waitFor();
  assert.equal(await cards.count(), 4);
  const cardNames = await host.page.locator('.cards .card-name').allTextContents();
  assert.deepEqual([...cardNames].sort(), [...names].sort());
  assert.equal(await host.page.locator('.cards img').count(), 0);
  assert.equal(await host.page.locator('img').count(), 0);

  await hostDraw(host, 4);

  const assigned = {};
  for (let i = 0; i < 3; i++) assigned[names[i + 1]] = await openGift(people[i]);

  // Host: not revealed until clicking.
  assigned[names[0]] = await revealHost(host);

  // One loop, everyone assigned exactly once, nobody gets themselves.
  for (const n of names) assert.notEqual(assigned[n], n, `${n} got themselves`);
  assert.deepEqual(Object.values(assigned).sort(), [...names].sort(), 'each person assigned exactly once');
  let cur = names[0];
  const seen = new Set();
  while (!seen.has(cur)) { seen.add(cur); cur = assigned[cur]; }
  assert.equal(cur, names[0], 'cycle returns to the start');
  assert.equal(seen.size, 4, 'single loop covers everyone');

  // Reload a participant: same assignment, no new draw.
  await people[0].page.reload();
  const again = await openGift(people[0]);
  assert.equal(again, assigned[names[1]]);

  // Reload the XSS-named participant too (name rendered in host list after reload).
  await host.page.reload();
  await host.page.locator('.view-host').waitFor();
  assert.equal(await host.page.locator('.cards .card').count(), 4);
  assert.equal(await host.page.locator('.cards img').count(), 0);

  await assertClean(everyone);
});

test('non-participating host: no reveal button, nobody draws the host', { timeout: 30000 }, async () => {
  const host = await newPerson('host');
  const people = [await newPerson('p1'), await newPerson('p2'), await newPerson('p3')];
  const names = ['Ann', 'Ben', 'Cy'];

  const code = await hostCreate(host, { participate: false });
  for (let i = 0; i < 3; i++) await join(people[i], code, names[i], `fact ${i}`);

  await host.page.getByText('3 people joined').waitFor();
  assert.equal(await host.page.locator('.cards .card').count(), 3);
  await hostDraw(host, 3);

  const assigned = {};
  for (let i = 0; i < 3; i++) assigned[names[i]] = await openGift(people[i]);
  for (const n of names) {
    assert.notEqual(assigned[n], n);
    assert.ok(names.includes(assigned[n]), `${n} was assigned a non-participant: ${assigned[n]}`);
  }
  assert.deepEqual(Object.values(assigned).sort(), [...names].sort());
  assert.equal(await host.page.getByRole('button', { name: 'Reveal my match' }).count(), 0);
  assert.equal(await host.page.locator('.reveal').count(), 0);

  await assertClean([host, ...people]);
});

test('host reload before the draw resumes identity and list', { timeout: 30000 }, async () => {
  const host = await newPerson('host');
  const people = [await newPerson('p1'), await newPerson('p2')];
  const code = await hostCreate(host, { name: 'Hosty' });
  await join(people[0], code, 'Alice', 'a');
  await join(people[1], code, 'Bob', 'b');
  await host.page.getByText('3 people joined').waitFor();

  await host.page.reload();
  await host.page.locator('.view-host').waitFor();
  assert.equal((await host.page.locator('.view-host .code').textContent()).trim(), code);
  await host.page.getByText('3 people joined').waitFor();
  const cardNames = await host.page.locator('.cards .card-name').allTextContents();
  assert.deepEqual([...cardNames].sort(), ['Alice', 'Bob', 'Hosty']);
  assert.equal(await host.page.getByRole('button', { name: 'I am the HOST' }).count(), 0);

  await assertClean([host, ...people]);
});
