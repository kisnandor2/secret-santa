// One render function per view; each returns a DOM node. All text via el()/textContent.
import { el } from './dom.js';
import { createReveal } from './reveal.js';

function field(id, label, control, hint) {
  return el('div', { class: 'field' },
    el('label', { for: id }, label),
    control,
    hint ? el('p', { class: 'hint' }, hint) : null,
  );
}

function errorBox() {
  return el('p', { class: 'form-error', role: 'alert', hidden: '' });
}
function showError(box, msg) {
  box.textContent = msg;
  box.hidden = !msg;
}

/** Runs an async submit handler, disabling the button and showing errors inline. */
function wireSubmit(form, button, errBox, handler) {
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (button.disabled) return;
    showError(errBox, '');
    button.disabled = true;
    try {
      await handler();
    } catch (e) {
      showError(errBox, e && e.message ? e.message : 'Something went wrong.');
      button.disabled = false;
    }
  });
}

function logo(sub) {
  return el('header', { class: 'brand' },
    el('h1', {}, 'Secret Santa'),
    sub ? el('p', { class: 'sub' }, sub) : null,
  );
}

export function renderLanding({ remembered, onHost, onParticipant, onContinue, onFresh }) {
  return el('section', { class: 'view view-landing' },
    logo('Draw names, keep it secret, share the joy.'),
    remembered
      ? el('div', { class: 'banner-card', role: 'group', 'aria-label': 'Resume previous session' },
        el('p', {}, `Continue as ${remembered.name || (remembered.role === 'host' ? 'host' : 'guest')} (${remembered.code})?`),
        el('div', { class: 'row' },
          el('button', { type: 'button', class: 'btn primary', onclick: onContinue }, 'Continue'),
          el('button', { type: 'button', class: 'btn ghost', onclick: onFresh }, 'Start fresh'),
        ))
      : null,
    el('div', { class: 'stack' },
      el('button', { type: 'button', class: 'btn primary big', onclick: onHost }, 'I am the HOST'),
      el('button', { type: 'button', class: 'btn secondary big', onclick: onParticipant }, 'I am a PARTICIPANT'),
    ),
  );
}

export function renderHostCreate({ onCreate, onBack }) {
  const name = el('input', { id: 'hc-name', type: 'text', maxlength: '40', autocomplete: 'off', required: '' });
  const fact = el('textarea', { id: 'hc-fact', maxlength: '200', rows: '3' });
  const skip = el('input', { id: 'hc-skip', type: 'checkbox' });
  const fields = el('div', { class: 'stack' },
    field('hc-name', 'Your name', name),
    field('hc-fact', 'A fun fact about you', fact, 'Optional. Your Secret Santa will see it.'),
  );
  skip.addEventListener('change', () => {
    fields.hidden = skip.checked;
    name.required = !skip.checked;
  });
  const err = errorBox();
  const submit = el('button', { type: 'submit', class: 'btn primary big' }, 'Create session');
  const form = el('form', { class: 'stack', novalidate: '' },
    fields,
    el('label', { class: 'check', for: 'hc-skip' }, skip, el('span', {}, 'I do NOT participate (organizer only)')),
    err, submit,
  );
  wireSubmit(form, submit, err, async () => {
    if (skip.checked) return onCreate({ participate: false });
    if (!name.value.trim()) throw new Error('Please enter your name.');
    return onCreate({ participate: true, name: name.value, funFact: fact.value });
  });
  return el('section', { class: 'view view-create' },
    logo('Create a session'),
    form,
    el('button', { type: 'button', class: 'btn link', onclick: onBack }, 'Back'),
  );
}

export function renderJoin({ code, onJoin, onBack }) {
  const codeIn = el('input', {
    id: 'jn-code', type: 'text', maxlength: '14', autocomplete: 'off', autocapitalize: 'characters',
    spellcheck: 'false', required: '', placeholder: 'FROSTY-427',
  });
  codeIn.value = code || '';
  const name = el('input', { id: 'jn-name', type: 'text', maxlength: '40', autocomplete: 'off', required: '' });
  const fact = el('textarea', { id: 'jn-fact', maxlength: '200', rows: '3' });
  const err = errorBox();
  const submit = el('button', { type: 'submit', class: 'btn primary big' }, 'Join');
  const form = el('form', { class: 'stack', novalidate: '' },
    field('jn-code', 'Session code', codeIn),
    field('jn-name', 'Your name', name),
    field('jn-fact', 'A fun fact about you', fact, 'Optional. Your Secret Santa will see it.'),
    err, submit,
  );
  wireSubmit(form, submit, err, async () => {
    if (!codeIn.value.trim()) throw new Error('Please enter the session code.');
    if (!name.value.trim()) throw new Error('Please enter your name.');
    return onJoin(codeIn.value.trim(), { name: name.value, funFact: fact.value });
  });
  const view = el('section', { class: 'view view-join' },
    logo('Join a session'),
    form,
    el('button', { type: 'button', class: 'btn link', onclick: onBack }, 'Back'),
  );
  return view;
}

export function renderConnecting() {
  return el('section', { class: 'view view-connecting' },
    logo(),
    el('p', { class: 'waiting', role: 'status' }, 'Connecting…'),
  );
}

export function renderWaiting({ name, code }) {
  return el('section', { class: 'view view-waiting' },
    logo(),
    el('p', { class: 'waiting pulse', role: 'status' }, 'Waiting for the host to draw…'),
    name ? el('p', { class: 'who' }, 'You joined as ', el('strong', {}, name)) : null,
    code ? el('p', { class: 'hint center' }, `Session ${code}`) : null,
  );
}

function card(p, { canRemove, onRemove, isNew }) {
  return el('li', { class: 'card' + (isNew ? ' enter' : ''), dataset: { id: p.id } },
    el('div', { class: 'card-head' },
      el('span', {
        class: 'dot ' + (p.connected ? 'on' : 'off'),
        role: 'img',
        'aria-label': p.connected ? 'connected' : 'disconnected',
      }),
      el('strong', { class: 'card-name' }, p.name),
      p.isHost ? el('span', { class: 'badge' }, 'host') : null,
      canRemove && !p.isHost
        ? el('button', {
          type: 'button', class: 'remove', 'aria-label': `Remove ${p.name}`,
          onclick: () => onRemove(p.id),
        }, '×')
        : null,
    ),
    p.funFact ? el('p', { class: 'card-fact' }, p.funFact) : null,
  );
}

export function renderHostRoom({
  code, participants, drawn, drawPending, connected, participates, hostResult, revealedByHost,
  animateHostReveal, seenIds, onCopy, onDraw, onEnd, onRemove, onRevealHost, onHideHost,
}) {
  const count = participants.length;
  const canDraw = count >= 3 && !drawn && !drawPending && connected;
  const drawBtn = el('button', { type: 'button', class: 'btn primary big', onclick: onDraw }, 'Draw!');
  drawBtn.disabled = !canDraw;

  const list = el('ul', { class: 'cards', 'aria-live': 'polite', 'aria-label': 'Participants' },
    participants.map((p) => card(p, { canRemove: !drawn, onRemove, isNew: !seenIds.has(p.id) })));

  let afterDraw = null;
  if (drawn) {
    const parts = [el('p', { class: 'done' }, 'Draw complete ✓')];
    if (participates) {
      if (!hostResult) {
        parts.push(el('p', { class: 'hint center' }, 'Waiting for your result…'));
      } else if (!revealedByHost) {
        parts.push(el('button', { type: 'button', class: 'btn secondary', onclick: onRevealHost }, 'Reveal my match'));
      } else {
        const r = createReveal({ assignedName: hostResult.assignedName, assignedFunFact: hostResult.assignedFunFact });
        r.open(animateHostReveal);
        parts.push(r.node);
        parts.push(el('button', { type: 'button', class: 'btn ghost', onclick: onHideHost }, 'Hide'));
      }
    }
    afterDraw = el('div', { class: 'stack center' }, parts);
  }

  return el('section', { class: 'view view-host' },
    logo('Share this code with your group'),
    el('div', { class: 'code-box' },
      el('p', { class: 'code', 'aria-label': `Session code ${code}` }, code),
      el('button', { type: 'button', class: 'btn secondary', onclick: onCopy }, 'Copy link'),
    ),
    el('p', { class: 'count', role: 'status' }, `${count} ${count === 1 ? 'person' : 'people'} joined`),
    list,
    count < 3 && !drawn ? el('p', { class: 'hint center' }, 'At least 3 participants are needed to draw.') : null,
    drawn ? afterDraw : drawBtn,
    el('button', { type: 'button', class: 'btn danger', onclick: onEnd }, 'End session'),
  );
}

export function renderReveal({ result, boxOpened, onOpened }) {
  const r = createReveal({
    assignedName: result.assignedName,
    assignedFunFact: result.assignedFunFact,
    onOpen: onOpened,
  });
  if (boxOpened) r.open(false);
  return el('section', { class: 'view view-reveal' },
    logo('The draw is done!'),
    r.node,
  );
}

export function renderEnded({ message, onBack }) {
  return el('section', { class: 'view view-ended' },
    logo(),
    el('p', { class: 'ended-msg', role: 'status' }, message),
    el('button', { type: 'button', class: 'btn primary big', onclick: onBack }, 'Back to start'),
  );
}

/** Native <dialog> confirm; returns { dialog, ask(title, body, confirmLabel) -> Promise<boolean> }. */
export function createConfirm() {
  const title = el('h2', { class: 'dlg-title' });
  const body = el('p', {});
  const ok = el('button', { type: 'button', class: 'btn primary' });
  const cancel = el('button', { type: 'button', class: 'btn ghost' }, 'Cancel');
  const dialog = el('dialog', { class: 'dlg', 'aria-labelledby': 'dlg-title' },
    title, body, el('div', { class: 'row' }, cancel, ok));
  title.id = 'dlg-title';
  let resolve = null;
  const done = (v) => {
    if (dialog.open) dialog.close();
    const r = resolve; resolve = null;
    r?.(v);
  };
  ok.addEventListener('click', () => done(true));
  cancel.addEventListener('click', () => done(false));
  dialog.addEventListener('cancel', () => done(false));
  dialog.addEventListener('close', () => done(false));
  return {
    dialog,
    ask(t, text, label) {
      title.textContent = t;
      body.textContent = text;
      ok.textContent = label;
      if (typeof dialog.showModal !== 'function') return Promise.resolve(window.confirm(`${t}\n${text}`));
      if (resolve) done(false);
      return new Promise((res) => { resolve = res; dialog.showModal(); ok.focus(); });
    },
  };
}
