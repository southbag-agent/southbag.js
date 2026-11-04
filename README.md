# southbag.js

The script applied across all Southbag sites. One tag gives a page the shared house behaviour:

```html
<script src="https://cdn.jsdelivr.net/gh/SouthbagHQ/southbag.js@main/southbag.js"
        data-app="banking"
        data-session-url="/api/session"></script>
```

## What it does

### 1. Kevin is always written "Kevin"

Anything typed into a text field or contenteditable region is corrected as it is typed
(`kevin`, `KEVIN`, `kEvIn` → `Kevin`; `@kevin` → `@Kevin`), keeping the caret where it was.
The correction runs in the capture phase, before app and framework handlers read the value, so
controlled inputs (Svelte, React, Vue) pick up `Kevin` without a second event.

Left alone on purpose:

- password, hidden, number, date and other non-text fields
- read-only and disabled fields
- code editors (CodeMirror, Monaco, Ace) and anything inside `[data-southbag-no-kevin]`
- unfinished IME composition (corrected on `compositionend`)
- lookalikes that are not the word: `kevins_stapler`, `skevin`

Some Southbag apps used to ship their own copy of this (`capitaliseKevin()` in Social and Git,
`normalizeKevin` in Office). Those are removed as each app adopts southbag.js — apps where the
per-field correction lives in framework state rather than the DOM keep their own copy until
they are verified compatible.

### 2. Palantir (analytics)

Southbag's PostHog wiring, moved here from the `palantir.js` file previously copied, byte for
byte, into every app. Same options, same `window.palantir` API:

| Attribute | Meaning |
| --- | --- |
| `data-app` | Name of the app (super property `southbag_app`). Defaults to the hostname. |
| `data-user-id` / `data-user-email` / `data-user-name` | The signed-in user as the server knows them. Identifies immediately. |
| `data-session-url` | Same-origin JSON endpoint returning `{ user: { id, email, name } }` (or `{ authenticated: false }`), used when the page has no `data-user-*`. |

When neither yields a user, Southbag Identity is asked directly: its session cookie lives on
`.southbag.cc`, so every Southbag app can resolve it with `credentials: "include"`. A confirmed
"no session" answer resets a stale identified profile back to anonymous.

Custom events: `window.palantir.capture("event_name", { … })`.

If a page still loads a vendored `palantir.js` alongside southbag.js, southbag.js detects the
existing PostHog instance and reuses it instead of initialising a second one.

### 3. Shared extras

- `window.southbag` — `{ version, kevin: { fix(text) }, palantir }`.
- A console banner. Kevin is watching.

## Opting out

On the script tag: `data-no-kevin`, `data-no-analytics`, `data-no-banner`.
Or before load:

```html
<script>
  window.southbagConfig = { noKevin: true, noAnalytics: true, noBanner: true };
</script>
```

Per field or subtree: `data-southbag-no-kevin`.

## Hosting

Until `js.southbag.cc` exists, the canonical URL is the jsDelivr mirror of this repo:

```
https://cdn.jsdelivr.net/gh/SouthbagHQ/southbag.js@main/southbag.js
```

Integrations pin an exact commit (`…/southbag.js@<sha>/southbag.js`) so a bad push can't
sail into production; bumping the pin is a one-line PR per app.

## Development

No build step. `southbag.js` is the file.

```
npm install
npm test
```

Commits here land via PR, like every other Southbag repo.
