import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const SRC = readFileSync(new URL('../southbag.js', import.meta.url), 'utf8');

function loadDom(bodyHtml = '', config = { noAnalytics: true, noBanner: true }) {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    url: 'https://social.southbag.cc/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  dom.window.southbagConfig = config;
  dom.window.eval(SRC);
  return dom;
}

function fireInput(window, el, { composing = false } = {}) {
  let event;
  try {
    event = new window.InputEvent('input', { bubbles: true, isComposing: composing });
  } catch {
    event = new window.Event('input', { bubbles: true });
    Object.defineProperty(event, 'isComposing', { value: composing });
  }
  el.dispatchEvent(event);
}

function type(window, el, text, opts) {
  el.value = text;
  fireInput(window, el, opts);
}

test('fix(): capitalises the finished word in any case', () => {
  const dom = loadDom();
  const fix = dom.window.southbag.kevin.fix;
  assert.equal(fix('kevin'), 'Kevin');
  assert.equal(fix('KEVIN'), 'Kevin');
  assert.equal(fix('kEvIn'), 'Kevin');
  assert.equal(fix('@kevin'), '@Kevin');
  assert.equal(fix('thanks, kevin.'), 'thanks, Kevin.');
  assert.equal(fix('kevin kevin'), 'Kevin Kevin');
  assert.equal(fix('Kevin'), 'Kevin');
});

test('fix(): leaves lookalikes alone', () => {
  const dom = loadDom();
  const fix = dom.window.southbag.kevin.fix;
  assert.equal(fix('kevins_stapler'), 'kevins_stapler');
  assert.equal(fix('skevin'), 'skevin');
  assert.equal(fix('kevinn'), 'kevinn');
  assert.equal(fix(''), '');
});

test('text input: corrects as you type and keeps the caret', () => {
  const dom = loadDom('<input id="t" type="text">');
  const { window } = dom;
  const el = window.document.getElementById('t');
  el.focus();
  type(window, el, 'hello kevin');
  assert.equal(el.value, 'hello Kevin');
  el.setSelectionRange(7, 7);
  el.value = 'hello Kevin, kevin again';
  el.setSelectionRange(13, 13);
  fireInput(window, el);
  assert.equal(el.value, 'hello Kevin, Kevin again');
  assert.equal(el.selectionStart, 13);
});

test('framework-style capture: value is fixed before bubble handlers read it', () => {
  const dom = loadDom('<input id="t" type="text">');
  const { window } = dom;
  const el = window.document.getElementById('t');
  let seen;
  el.addEventListener('input', (e) => { seen = e.target.value; }); // bubble phase, like a framework binding
  type(window, el, 'kevin');
  assert.equal(seen, 'Kevin');
});

test('textarea is corrected', () => {
  const dom = loadDom('<textarea id="t"></textarea>');
  const { window } = dom;
  const el = window.document.getElementById('t');
  type(window, el, 'dear kevin');
  assert.equal(el.value, 'dear Kevin');
});

test('password, number, email-excluded types and read-only fields are left alone', () => {
  const dom = loadDom(
    '<input id="p" type="password"><input id="n" type="number"><input id="h" type="hidden">' +
    '<input id="r" type="text" readonly><input id="d" type="text" disabled><input id="e" type="email">'
  );
  const { window } = dom;
  for (const id of ['p', 'h', 'r', 'd']) {
    const el = window.document.getElementById(id);
    type(window, el, 'kevin');
    assert.equal(el.value, 'kevin', id);
  }
  const num = window.document.getElementById('n');
  type(window, num, '5'); // number fields can't hold "kevin" anyway; assert no correction attempt
  assert.equal(num.value, '5', 'n');
  const em = window.document.getElementById('e');
  type(window, em, 'kevin@southbag.cc');
  assert.equal(em.value, 'Kevin@southbag.cc');
});

test('data-southbag-no-kevin opts out a subtree', () => {
  const dom = loadDom('<div data-southbag-no-kevin><input id="t" type="text"></div>');
  const { window } = dom;
  const el = window.document.getElementById('t');
  type(window, el, 'kevin');
  assert.equal(el.value, 'kevin');
});

test('code editor roots are left alone', () => {
  const dom = loadDom('<div class="cm-content" contenteditable="true">kevin</div>');
  const { window } = dom;
  const el = window.document.querySelector('.cm-content');
  fireInput(window, el);
  assert.equal(el.textContent, 'kevin');
});

test('contenteditable text is corrected', () => {
  const dom = loadDom('<div id="ed" contenteditable="true"></div>');
  const { window } = dom;
  const ed = window.document.getElementById('ed');
  ed.appendChild(window.document.createTextNode('hello kevin'));
  fireInput(window, ed);
  assert.equal(ed.textContent, 'hello Kevin');
});

test('IME composition is not disturbed mid-composition, fixed on compositionend', () => {
  const dom = loadDom('<input id="t" type="text">');
  const { window } = dom;
  const el = window.document.getElementById('t');
  el.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true }));
  type(window, el, 'kevin');
  assert.equal(el.value, 'kevin'); // untouched while composing
  el.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true }));
  assert.equal(el.value, 'Kevin');
});

test('isComposing input events are ignored', () => {
  const dom = loadDom('<input id="t" type="text">');
  const { window } = dom;
  const el = window.document.getElementById('t');
  type(window, el, 'kevin', { composing: true });
  assert.equal(el.value, 'kevin');
});

test('data-no-kevin disables correction only', () => {
  const dom = loadDom('<input id="t" type="text">', { noKevin: true, noAnalytics: true, noBanner: true });
  const { window } = dom;
  const el = window.document.getElementById('t');
  type(window, el, 'kevin');
  assert.equal(el.value, 'kevin');
  assert.equal(typeof window.southbag.version, 'string');
});

test('palantir: queues PostHog init with the shared project and exposes window.palantir', () => {
  const dom = loadDom('', { noKevin: true, noBanner: true, app: 'social' });
  const { window } = dom;
  assert.ok(window.posthog, 'posthog stub exists');
  assert.equal(typeof window.posthog.init, 'function');
  const inits = window.posthog._i.filter((c) => c[0] === undefined || Array.isArray(c));
  const init = window.posthog._i.find((c) => Array.isArray(c) && typeof c[0] === 'string');
  assert.ok(init, 'init was queued');
  assert.equal(init[0], 'phc_rStyYsw4wrB8MwXEsPBJjz57uipHycNVwFPaw2m3aYXo');
  assert.equal(init[1].api_host, 'https://palantir.southbag.cc');
  assert.equal(typeof window.palantir.capture, 'function');
  assert.equal(typeof window.palantir.identify, 'function');
  assert.equal(window.southbag.palantir, window.palantir);
  const loader = window.document.querySelector('script[src*="array.js"]');
  assert.ok(loader, 'array.js loader was inserted');
});

test('palantir: data-no-analytics leaves no PostHog behind', () => {
  const dom = loadDom('', { noAnalytics: true, noKevin: true, noBanner: true });
  assert.equal(dom.window.posthog, undefined);
  assert.equal(dom.window.palantir, undefined);
});

test('palantir: an existing vendored palantir.js instance is reused, not re-initialised', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://social.southbag.cc/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  let inits = 0;
  window.posthog = { __loaded: true, capture() {}, identify() { inits++; }, reset() {} };
  window.southbagConfig = { noKevin: true, noBanner: true };
  window.eval(SRC);
  assert.equal(typeof window.palantir.capture, 'function');
  window.palantir.identify({ id: 7 });
  assert.equal(inits, 1);
});

test('banner: logged unless data-no-banner', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://social.southbag.cc/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const lines = [];
  const orig = window.console.log;
  window.console.log = (...args) => lines.push(args.join(' '));
  window.southbagConfig = { noAnalytics: true, noKevin: true };
  window.eval(SRC);
  window.console.log = orig;
  assert.ok(lines.some((l) => l.includes('Kevin is watching')));
});
