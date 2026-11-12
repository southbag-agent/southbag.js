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
  installExecCommandShim(dom.window);
  dom.window.eval(SRC);
  return dom;
}

// jsdom has no document.execCommand. Shim just "insertText", faithfully enough:
// for input/textarea it replaces the current selection in the focused field and
// fires an input event; for contenteditable it replaces the selected range.
function installExecCommandShim(window) {
  window.document.execCommand = function (cmd, showUI, text) {
    if (cmd !== 'insertText') return false;
    const doc = window.document;
    const active = doc.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
      const start = active.selectionStart, end = active.selectionEnd;
      active.value = active.value.slice(0, start) + text + active.value.slice(end);
      active.setSelectionRange(start + text.length, start + text.length);
      active.dispatchEvent(new window.Event('input', { bubbles: true }));
      return true;
    }
    const sel = doc.getSelection();
    if (!sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    const root = range.commonAncestorContainer.nodeType === 1
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    if (!root || !root.closest('[contenteditable]')) return false;
    range.deleteContents();
    const node = window.document.createTextNode(text);
    range.insertNode(node);
    sel.setBaseAndExtent(node, text.length, node, text.length);
    root.closest('[contenteditable]').dispatchEvent(new window.Event('input', { bubbles: true }));
    return true;
  };
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
  if (el.focus) el.focus(); // typing implies focus; southbag.js never writes unfocused fields
  el.value = text;
  fireInput(window, el, opts);
}

function keydown(window, el, key) {
  el.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key }));
}

test('fix(): capitalises the finished word in any case', () => {
  const dom = loadDom();
  const fix = dom.window.southbag.kevin.fix;
  assert.equal(fix('kevin'), 'Kevin');
  assert.equal(fix('KEVIN'), 'Kevin');
  assert.equal(fix('kEvIn'), 'Kevin');
  assert.equal(fix('thanks, kevin.'), 'thanks, Kevin.');
  assert.equal(fix('kevin kevin'), 'Kevin Kevin');
  assert.equal(fix("kevin's"), "Kevin's");
  assert.equal(fix('Kevin'), 'Kevin');
});

test('fix(): never touches identifiers (emails, URLs, query strings, handles)', () => {
  const dom = loadDom();
  const fix = dom.window.southbag.kevin.fix;
  assert.equal(fix('kevin@southbag.cc'), 'kevin@southbag.cc');
  assert.equal(fix('mail me at kevin@x.com please'), 'mail me at kevin@x.com please');
  assert.equal(fix('southbag.cc/kevin'), 'southbag.cc/kevin');
  assert.equal(fix('https://kevin.example.com'), 'https://kevin.example.com');
  assert.equal(fix('?q=kevin'), '?q=kevin');
  assert.equal(fix('q=kevin&page=2'), 'q=kevin&page=2');
  assert.equal(fix('@kevin'), '@kevin');
  assert.equal(fix('user:+kevin'), 'user:+kevin');
  assert.equal(fix('~kevin'), '~kevin');
  assert.equal(fix('100%kevin'), '100%kevin');
  assert.equal(fix('see southbag.cc/kevin for kevin himself'), 'see southbag.cc/kevin for Kevin himself');
});

test('fix(): leaves lookalikes alone', () => {
  const dom = loadDom();
  const fix = dom.window.southbag.kevin.fix;
  assert.equal(fix('kevins_stapler'), 'kevins_stapler');
  assert.equal(fix('skevin'), 'skevin');
  assert.equal(fix('kevinn'), 'kevinn');
  assert.equal(fix(''), '');
});

test('text input: the word under the caret is left alone while typing', () => {
  const dom = loadDom('<input id="t" type="text">');
  const { window } = dom;
  const el = window.document.getElementById('t');
  el.focus();
  el.value = 'hello kevin';
  el.setSelectionRange(11, 11); // caret right after the word - it may grow into an identifier
  fireInput(window, el);
  assert.equal(el.value, 'hello kevin');
  el.value = 'hello kevin '; // next keystroke finishes the word
  el.setSelectionRange(12, 12);
  fireInput(window, el);
  assert.equal(el.value, 'hello Kevin ');
  assert.equal(el.selectionStart, 12);
});

test('text input: trailing word is fixed on Tab/Enter, while still focused', () => {
  const dom = loadDom('<input id="t" type="text">');
  const { window } = dom;
  const el = window.document.getElementById('t');
  el.focus();
  el.value = 'hello kevin';
  el.setSelectionRange(11, 11);
  fireInput(window, el);
  assert.equal(el.value, 'hello kevin'); // caret still on the word
  keydown(window, el, 'Tab');
  assert.equal(el.value, 'hello Kevin');
});

test('text input: trailing word is fixed when the pointer leaves the field', () => {
  const dom = loadDom('<input id="t" type="text"><button id="b">x</button>');
  const { window } = dom;
  const el = window.document.getElementById('t');
  el.focus();
  el.value = 'hello kevin';
  el.setSelectionRange(11, 11);
  fireInput(window, el);
  assert.equal(el.value, 'hello kevin');
  window.document.getElementById('b').dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  assert.equal(el.value, 'hello Kevin');
});

test('an unfocused field is never mutated', () => {
  const dom = loadDom('<input id="t" type="text"><input id="o" type="text">');
  const { window } = dom;
  const el = window.document.getElementById('t');
  window.document.getElementById('o').focus(); // focus is elsewhere
  el.value = 'kevin kevin';
  fireInput(window, el);
  assert.equal(el.value, 'kevin kevin');
});

test('text input: undo and redo are never re-corrected', () => {
  const dom = loadDom('<input id="t" type="text">');
  const { window } = dom;
  const el = window.document.getElementById('t');
  el.focus();
  el.value = 'kevin';
  el.setSelectionRange(5, 5);
  let ev;
  try {
    ev = new window.InputEvent('input', { bubbles: true, inputType: 'historyUndo' });
  } catch {
    ev = new window.Event('input', { bubbles: true });
    Object.defineProperty(ev, 'inputType', { value: 'historyUndo' });
  }
  el.dispatchEvent(ev);
  assert.equal(el.value, 'kevin');
  keydown(window, el, 'Enter');
  assert.equal(el.value, 'Kevin');
});

test('text input: corrects as you type and keeps the caret', () => {
  const dom = loadDom('<input id="t" type="text">');
  const { window } = dom;
  const el = window.document.getElementById('t');
  el.focus();
  type(window, el, 'hello kevin x');
  assert.equal(el.value, 'hello Kevin x');
  el.value = 'hello Kevin, kevin again';
  el.setSelectionRange(13, 13); // caret at the start of the second "kevin"
  fireInput(window, el);
  assert.equal(el.value, 'hello Kevin, kevin again'); // caret sits on it - untouched
  el.setSelectionRange(0, 0);
  fireInput(window, el);
  assert.equal(el.value, 'hello Kevin, Kevin again');
  assert.equal(el.selectionStart, 0);
});

test('framework-style capture: value is fixed before bubble handlers read it', () => {
  const dom = loadDom('<input id="t" type="text">');
  const { window } = dom;
  const el = window.document.getElementById('t');
  let seen;
  el.addEventListener('input', (e) => { seen = e.target.value; }); // bubble phase, like a framework binding
  type(window, el, 'kevin,');
  assert.equal(seen, 'Kevin,');
});

test('textarea is corrected', () => {
  const dom = loadDom('<textarea id="t"></textarea>');
  const { window } = dom;
  const el = window.document.getElementById('t');
  type(window, el, 'dear kevin,');
  assert.equal(el.value, 'dear Kevin,');
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
});

test('identifier fields (email, url, search) are never touched', () => {
  const dom = loadDom(
    '<input id="e" type="email"><input id="u" type="url"><input id="s" type="search">'
  );
  const { window } = dom;
  for (const [id, v] of [['e', 'kevin@southbag.cc'], ['u', 'https://southbag.cc/kevin'], ['s', 'kevin']]) {
    const el = window.document.getElementById(id);
    type(window, el, v);
    assert.equal(el.value, v, id);
  }
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
  ed.appendChild(window.document.createTextNode('hello kevin '));
  ed.focus();
  const sel = window.document.getSelection();
  sel.setBaseAndExtent(ed.firstChild, 12, ed.firstChild, 12); // caret past the word, as after a space
  fireInput(window, ed);
  assert.equal(ed.textContent, 'hello Kevin ');
  // a word the caret still sits on is left alone (it may grow into an identifier)
  ed.textContent = 'hello kevin';
  sel.setBaseAndExtent(ed.firstChild, 11, ed.firstChild, 11);
  fireInput(window, ed);
  assert.equal(ed.textContent, 'hello kevin');
});

test('IME: untouched mid-composition; compositionend does not rush the word', () => {
  const dom = loadDom('<input id="t" type="text">');
  const { window } = dom;
  const el = window.document.getElementById('t');
  el.focus();
  el.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true }));
  el.value = 'kevin';
  fireInput(window, el, { composing: true });
  assert.equal(el.value, 'kevin'); // untouched while composing
  el.setSelectionRange(5, 5);
  el.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true }));
  assert.equal(el.value, 'kevin'); // caret still on the word: it may grow into an identifier
  el.value = 'kevin san';
  el.setSelectionRange(9, 9);
  fireInput(window, el);
  assert.equal(el.value, 'Kevin san'); // next keystroke fixes it
});

test('IME: a word committed then extended into an identifier stays lowercase', () => {
  const dom = loadDom('<input id="t" type="text">');
  const { window } = dom;
  const el = window.document.getElementById('t');
  el.focus();
  el.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true }));
  el.value = 'kevin';
  fireInput(window, el, { composing: true });
  el.setSelectionRange(5, 5);
  el.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true }));
  el.value = 'kevin@x.com'; // user keeps typing an email address
  el.setSelectionRange(11, 11);
  fireInput(window, el);
  assert.equal(el.value, 'kevin@x.com');
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

test('no console banner; namespace is exposed', () => {
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
  assert.equal(lines.filter((l) => l.includes('Kevin is watching')).length, 0);
  assert.equal(window.southbag.version, '0.2.2');
});
