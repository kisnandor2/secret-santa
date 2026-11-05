// Gift-box reveal component + confetti
import { el } from './dom.js';

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function fireConfetti() {
  if (reducedMotion()) return;
  if (typeof confetti !== 'function') return; // vendored global; may be missing
  try {
    confetti({ particleCount: 140, spread: 80, origin: { y: 0.65 } });
  } catch { /* cosmetic only */ }
}

/**
 * Gift box. Starts closed; click/tap/Enter opens it and shows the result.
 * Returns { node, open(), cover() }.
 */
export function createReveal({ assignedName, assignedFunFact, onOpen } = {}) {
  let isOpen = false;
  const prompt = el('p', { class: 'reveal-prompt' }, 'Tap the gift to open it');
  const result = el('div', { class: 'reveal-result', hidden: '' },
    el('p', { class: 'reveal-label' }, 'You are the Secret Santa for'),
    el('p', { class: 'reveal-name' }, assignedName),
    assignedFunFact
      ? el('p', { class: 'reveal-fact' }, 'Fun fact: ', assignedFunFact)
      : null,
  );
  const box = el('button', {
    type: 'button',
    class: 'gift',
    'aria-label': 'Gift box. Activate to open and see who you drew.',
  },
    el('span', { class: 'gift-lid' }),
    el('span', { class: 'gift-body' }),
    el('span', { class: 'gift-ribbon' }),
  );
  const node = el('div', { class: 'reveal' }, box, prompt, result);

  function open(withConfetti = true) {
    if (isOpen) return;
    isOpen = true;
    node.classList.add('is-open');
    box.setAttribute('aria-expanded', 'true');
    box.setAttribute('aria-label', 'Gift box, opened.');
    result.hidden = false;
    prompt.hidden = true;
    if (withConfetti) fireConfetti();
    onOpen?.();
  }
  function cover() {
    isOpen = false;
    node.classList.remove('is-open');
    box.setAttribute('aria-expanded', 'false');
    result.hidden = true;
    prompt.hidden = false;
  }
  box.addEventListener('click', () => open());
  return { node, open, cover, isOpen: () => isOpen };
}
