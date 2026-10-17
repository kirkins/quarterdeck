# Decisions

Why Quarterdeck is built the way it is. Newest last.

## 1. SvelteKit + TypeScript on Node, with adapter-node

A small, readable codebase that has both server routes (to call the privateer CLI) and a reactive UI (one-tap answers now, a live fleet map later) in one app. adapter-node gives one Node process that can later sit behind a login proxy. Node 26 and npm.

## 2. No CSS framework

Hand-written CSS with design tokens as custom properties (`src/app.css`) for colour, type, spacing and radii. Light and dark use CSS `light-dark()`: the scheme follows the system unless the theme toggle sets `data-theme` on `<html>`. The saved theme is a cookie that the server renders into the page, so the first paint is already in the right theme and no inline script is needed.

Palette: sail-canvas paper, deep navy ink, sea-glass for action and selection, brass for the ship's recommendation, red and amber for overdue and soon. The nautical theme is seasoning; clarity comes first.

## 3. Dependencies

There are **no runtime dependencies** beyond SvelteKit: everything in `package.json` is a dev dependency and the built server bundles what it needs.

- `@fontsource-variable/fraunces` (dev dependency, OFL-1.1): the display face for the wordmark and card questions, self-hosted and bundled at build time so pages never call a font CDN. Only the Latin subsets a page actually uses are downloaded (`unicode-range`). Body text uses the system UI font.
- Tooling: vitest (data layer and schema), Playwright (smoke test and screenshots, chromium only), eslint + prettier + svelte-check. These came from the official `sv create` templates.

## 4. Reading Privateer: the CLI, argv only

`src/lib/server/privateer.ts` runs `[bin, "--home", home, command, "--json", JSON.stringify(args)]` with `execFile` and `shell: false`. The binary and home come from `PRIVATEER_BIN` and `PRIVATEER_HOME`; nothing fleet-specific is in code. `{"ok": false, "error": ...}` becomes a `PrivateerCommandError`; a missing binary, timeout or non-zero exit becomes a `PrivateerExecError` (whose message reports the exit code rather than echoing the command line); non-JSON output becomes a `PrivateerParseError`.

Configuration is read from `process.env` in one module (`src/lib/server/config.ts`) rather than SvelteKit's env modules, so the data layer is plain TypeScript that unit tests can import and configure directly.

## 5. Sources: fixtures by default

A `Source` interface has two implementations: `CliSource` (merges `captain.waiting` and `runtime.needs`, de-duplicated by mail id) and `FixtureSource` (reads the same shapes from `fixtures/`). `QD_SOURCE` selects one and defaults to `fixtures` everywhere, so a fresh checkout, CI and tests can never touch a fleet.

Fixture timestamps are rebased to "now" when read (`fixture_now_ms` in each file), so an ask that is "due in 40 minutes" stays that way and an overdue one stays overdue.

The exact wrapper key of the `captain.waiting` / `runtime.needs` results was not available to build against (they are operator-only), so `extractItems` accepts a bare list or a list under `messages`, `items`, `waiting`, `needs` or `mail`. Fixtures use `messages`, like `mail.inbox`.

## 6. Sending is opt-in twice

An answer is only really sent when `QD_SOURCE=cli` **and** `QD_ALLOW_SEND=1`. Otherwise the server logs the exact `mail.send` arguments and the argv it would run, and records the answer in memory so the card shows as answered. Tests pin `QD_SOURCE=fixtures` and `QD_ALLOW_SEND=0`.

## 7. Answering: choose, then confirm

A tap only selects an option; sending takes a second, deliberate press of **Send answer** (with Cancel and Escape to back out). This guards against stray taps on a phone without a timed undo, which would need the server to hold mail back. The form is a plain POST to a SvelteKit form action and works without JavaScript; with it, the page updates in place. The recommended option is marked with a badge and a brass tint but never preselected.

Within one server process, a second answer to the same ask is refused, including two arriving at once.

## 8. Malformed or older asks are shown, not dropped

- Older mail with only `payload.choices` and a body becomes a simpler card: the body is split into a headline (the sentence that asks) and context, and the choices become options without details. The reply carries the chosen words in `payload.answer.text` and the body, since those ships have no option ids.
- A `payload.decision` that fails validation is shown from its body, with the problems listed under a disclosure, and can be answered in words.
- Plain requests without choices are not decisions; they will belong to Triage.

## 9. Listen on loopback; no auth in v0

The portal acts as the captain. Dev, preview and `npm start` bind `127.0.0.1` unless `HOST` is set (`server.js` sets the default because adapter-node's is `0.0.0.0`). There is no authentication in v0; the README says plainly that an authenticating proxy is required before any non-local exposure.

v0 leans on loopback for its safety, and nothing else. The answer form is a plain POST to `?/answer` with no CSRF token. The only guard is SvelteKit's origin check, which rejects a form POST whose `Origin` does not match the app's own origin. That protects a browser on another site from answering on the captain's behalf, but it is not authentication and it is not a substitute for one. Before the authenticating proxy goes in, review this again: check that the proxy passes the public origin through (or set `kit.paths.origin`, or `csrf.trustedOrigins`), since a rewritten Host would make the captain's own answers fail, and decide whether a token is needed as well.

## 10. Every decision takes the captain's own answer

The captain can always answer in their own words, whatever the ship asked for. Options stay the primary, one-tap path. Below them, a dashed row reads "Write my own answer"; choosing it clears any option picked so far and opens a text field; picking an option afterwards closes it and keeps any text as a note. Writing a note under a chosen option sends both. The own answer goes through the same confirm step as an option, and with JavaScript Send stays hidden until there is an option or some non-blank text. Without JavaScript the text field and Send are always shown, and the server refuses an empty answer.

`free_text_ok` is now only a hint that the ship especially invites a written answer. It changes the row's wording and nothing else. Privateer was asked to drop its gate on text answers, and until it does a live text-only reply can be refused; the card shows that refusal and keeps the text, so nothing is lost silently.

The reply shapes are fixed: an option alone is `{option_id}`; an option with a note is `{option_id, text}`; an own answer is `{text}`, with the text as the body. Every reply carries `task_id` when the ask has one.
