# Decisions

Why Quarterdeck is built the way it is. Newest last.

## 1. SvelteKit + TypeScript on Node, with adapter-node

A small, readable codebase that has both server routes (to call the privateer CLI) and a reactive UI (one-tap answers now, a live fleet map later) in one app. adapter-node gives one Node process that can later sit behind a login proxy. Node 26 and npm.

## 2. No CSS framework

Hand-written CSS with design tokens as custom properties (`src/app.css`) for colour, type, spacing and radii. Light and dark use CSS `light-dark()`: the scheme follows the system unless the theme toggle sets `data-theme` on `<html>`. The saved theme is a cookie that the server renders into the page, so the first paint is already in the right theme and no inline script is needed.

Palette: sail-canvas paper, deep navy ink, sea-glass for action and selection, brass for the ship's recommendation, red and amber for overdue and soon. The nautical theme is seasoning; clarity comes first.

## 3. Dependencies

There are **no runtime dependencies** beyond SvelteKit, with one exception: `marked`, which renders Markdown reports on the server (section 15). Everything else in `package.json` is a dev dependency and the built server bundles what it needs.

- `@fontsource-variable/fraunces` (dev dependency, OFL-1.1): the display face for the wordmark and card questions, self-hosted and bundled at build time so pages never call a font CDN. Only the Latin subsets a page actually uses are downloaded (`unicode-range`). Body text uses the system UI font.
- Tooling: vitest (data layer and schema), Playwright (smoke test and screenshots, chromium only), eslint + prettier + svelte-check. These came from the official `sv create` templates.

## 4. Reading Privateer: the CLI, argv only

`src/lib/server/privateer.ts` runs `[bin, "--home", home, command, "--json", JSON.stringify(args)]` with `execFile` and `shell: false`. The binary and home come from `PRIVATEER_BIN` and `PRIVATEER_HOME`; nothing fleet-specific is in code. `{"ok": false, "error": ...}` becomes a `PrivateerCommandError`; a missing binary, timeout or non-zero exit becomes a `PrivateerExecError` (whose message reports the exit code rather than echoing the command line); non-JSON output becomes a `PrivateerParseError`.

Configuration is read from `process.env` in one module (`src/lib/server/config.ts`) rather than SvelteKit's env modules, so the data layer is plain TypeScript that unit tests can import and configure directly.

## 5. Sources: fixtures by default

A `Source` interface has two implementations: `CliSource` (merges `captain.waiting` and `runtime.needs`, de-duplicated by mail id) and `FixtureSource` (reads the same shapes from `fixtures/`). `QD_SOURCE` selects one and defaults to `fixtures` everywhere, so a fresh checkout, CI and tests can never touch a fleet.

Fixture timestamps are rebased to "now" when read (`fixture_now_ms` in each file), so an ask that is "due in 40 minutes" stays that way and an overdue one stays overdue.

The wrapper keys are now known from Privateer's source (see section 11), so the guessing is gone. `captain.waiting` returns `{waiting: [{ship, asked_ms, age_ms, step, mail}], hands_on, now_ms}`, and `runtime.needs` returns `{available, items, reason?}`. `src/lib/shapes.ts` reads exactly those, and fixtures use the same shapes.

## 6. Sending is opt-in twice

An answer is only really sent when `QD_SOURCE=cli` **and** `QD_ALLOW_SEND=1`. Otherwise the server logs the exact `captain.reply` or `captain.dismiss` arguments and the argv it would run, and records the answer in memory so the card shows as answered. Tests pin `QD_SOURCE=fixtures` and `QD_ALLOW_SEND=0`.

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

The reply shapes are fixed: an option alone is `{option_id}`; an option with a note is `{option_id, text}`; an own answer is `{text}`, with the text as the body. The reply is `captain.reply {id, body, payload}` and carries no `task_id` (see section 12).

## 11. Triage: one item model, read from Privateer's real output

Triage and Decisions read the same data through `loadItems()` (`src/lib/server/app.ts`), so they cannot disagree about what is owed. Both queries are parsed by `src/lib/shapes.ts`; the list is ordered and sectioned by `src/lib/triage.ts`.

**Source of truth** (Privateer's source: `src/captain.rs` `waiting`, `src/needs.rs` `query`, `src/mail.rs` `hands_step`, `send`, `ack`). Command and field names only:

- `captain.waiting` returns `{now_ms, hands_on, waiting}`. Each entry is `{ship, asked_ms, age_ms, step, mail}`. `step` is the exact `payload.needs_hands.step` of a request to the captain, or null. `mail` is the mail record, with `kind` (`request` or `decision`), `request_kind`, `payload`, `urgency`, `deadline_ms` and `created_ms`.
- `runtime.needs` returns `{available, items, next_after, unknown, reason?}`. Each item has `id`, `source` (`mail`, `job`, `schedule` or `workspace`), `kind` (`decision`, `approval` or `blocker`), `ship`, `task_id`, `correlation` (the mail id, for mail), `question`, `choices`, `artifact`, `environment`, `evidence`, `status`, `summary`, `created_ms` and `actions`. Mail items carry no urgency, deadline or mail kind.
- Replies are `captain.reply {id, body, payload}`, keyed by the ask's id (see section 12). A reply closes the ask.
- There is no per-item acknowledgement. `mail.ack` moves a mailbox's read cursor (`through_seq`) and closes nothing, and blocked items offer no action, so Triage has no ack action.

**Merging.** A mail both queries report is one item. `captain.waiting`'s record wins, since it has the kind, payload, urgency and deadline. Ships choose their own mail ids, so items are keyed by sender and id.

**Sections and order.** Urgency high first; then overdue; then the nearest deadline (none last); then the oldest ask; then the id, so ties never depend on Privateer's listing order. "Needs you now" holds high urgency, overdue, and anything due within a day. "Waiting on you" is normal urgency. "When you have a moment" is low urgency. Empty sections are hidden.

**Actions, by kind.**

- A decision opens its existing card in place, and answers through the same action as the Decisions page (`submitAnswer`).
- A request or question takes a written reply. A needs-hands request shows its step with a copy button and a Done action, which replies "Done." to the asker.
- An approval is shown read-only. Production approvals need the exact grant or denial, which only Privateer records.
- A blocked item is shown with its summary and status. Quarterdeck offers nothing on it.

Answering, replying and sending all go through one guard: nothing is sent unless `QD_SOURCE=cli` and `QD_ALLOW_SEND=1`, as for decisions.

**Reads are cached for five seconds** (`loadItems`), so the nav badge in the layout and the page share one round trip. Any answer or reply reads fresh and clears the cache.

**Filters** by ship and kind are chips. The last filter is remembered in `localStorage` (guarded by try/catch). The list refreshes every 60 seconds and on window focus, and shows "Updated Xs ago".

## 12. Dismiss, one write path, and one key for an ask

**Dismiss** ends one captain-addressed ask without a reply, through `captain.dismiss {id, note?}`. A request or decision ends as dismissed, a notice or report is marked acknowledged for the captain, and a needs_hands ask closes. The action is a quiet `<details>` summary; its confirm step holds the optional note and the submit, so a stray tap only opens it. A cancel sends nothing. It works without JavaScript, and a refused dismiss reopens the step with the error on the item.

Wording comes from one module (`src/lib/dismiss.ts`): **Dismiss** for requests, decisions and approvals, **Mark read** for notices and reports, and **Done, nothing to add** for a needs_hands step (the **Done, I did this** reply stays beside it). Blockers have no dismiss: they are not captain mail, and `captain.dismiss` is for captain-addressed items.

**One key for an ask.** A ship picks its own mail ids, so an id alone is not unique. `askKey(from, id)` in `src/lib/decision.ts` is the key everywhere: the answered and dismissed map, the card and row dedup, the open row on Triage, the forms (they post `from` and `id`), and the lookup in `submit.ts`. An id that two ships both use is two asks.

**One write path.** Every privateer write goes through `CliSource.write` in `src/lib/server/source.ts`, and the send guard (`sendWrite`) sits in front of it: nothing is written unless `QD_SOURCE=cli` and `QD_ALLOW_SEND=1`.

**Agreed with Privateer (not built there yet).** Privateer adds two operator-only commands, and Quarterdeck builds against their names:

- `captain.reply {id, body?, payload?}` answers an ask. `payload.answer` is the answer as before. Quarterdeck sends no `from`, `to`, `correlation` or `task_id`: a reply links through the ask's id, and a task id only means something in its own home.
- `captain.dismiss {id, note?}` closes an ask without a reply. It takes the same route as `captain.reply`, and it takes no `from` either.

Privateer finds the open ask across this machine's homes, and over the gateway for linked machines. So the portal needs only one `--home` (any) and the item id. The earlier question of a per-home `--home` or `captain.relay` is answered: neither is needed here. Live answering and dismissing stay off until Privateer's commands land.

**Still open for Privateer:** a mail need's `kind` in runtime.needs may now be `request`, `notice` or `report` as well as `decision` and `approval`. Quarterdeck reads it that way until Privateer confirms the names.

**Newer runtime.needs fields are optional.** `urgency`, `deadline_ms`, `asked_ms` and `mail_id` are read when present. Older Privateer sends none of them, so those asks sort as normal urgency with no deadline, and captain.waiting still supplies them when it lists the same ask.

## 13. Fleet map: read-only, built on a provisional `fleet.snapshot`

**The fleet map** (`/fleet`) shows machine, then ship, then crew: each machine with its reachability and ships, each ship with its presence, open tasks and needs, and each running crew job with what it is doing now, how long it has run, whether it is heavy, and any wait. It only reads. Nothing on the page changes the fleet.

**Provisional shape.** Privateer is adding an operator-only `fleet.snapshot {}` that returns one JSON across all machines. Its PR is not out yet, so Quarterdeck builds against the shape Privateer described and marks it provisional:

```
{ generated_ms,
  machines: [ { name, reachable, changed_ms,
     ships: [ { name, scope, presence, open_tasks,
        jobs: [ { id, task_id, task_title, doing_now, started_ms, heavy, waits } ] } ],
     routes?: [ { name, state, until_ms? } ] } ],
  needs: [ { id, ship, kind, ... } ] }
```

It is parsed in one place, `parseSnapshot` in `src/lib/shapes.ts`. Every field is optional, extra fields are ignored, and a missing value becomes null, zero or empty, so a richer or poorer snapshot still renders. When Privateer's PR lands, adjust `parseSnapshot` and its tests alone.

**An older Privateer.** If the CLI refuses `fleet.snapshot` as an unknown command, the page shows a calm "does not offer a fleet map yet" state. Only that case is treated this way (`isUnknownCommand` in `src/lib/server/source.ts`); a timeout or any other failure shows the error state.

**Sorting** (`src/lib/fleet.ts`). Machines with needs or running crew come first, then idle reachable machines, then unreachable ones; ties sort by name. Within a machine, ships with needs come first, then ships with crew, then awake ships, then asleep ones. An unreachable machine shows its ship names only, with no counts, because its numbers are stale.

**Refresh.** The page re-runs its load every 15 s while the tab is visible, and again on focus or when the tab becomes visible. Refreshes use `invalidate('quarterdeck:fleet')`, which re-runs only this page's load and leaves the component mounted, so the collapsed machines stay collapsed and the scroll position stays put.

**Needs link to triage.** A ship's "items need you" link goes to `/triage?ship=<name>`. Triage reads that ship from the URL and filters to it, and the URL choice wins over the remembered filter.

## 14. Spend view: read-only, built on provisional `routes.show` and `usage.summary`

**The spend view** (`/spend`) shows two things. **Routes now** lists each model route in the order crew try them, with its cost class (free, plan or credits), its state on each machine (available, backing off, or capped, with a relative time until it clears), its last error on demand, and its note from `routes.show`. Throttled routes come first. **Usage** shows token totals for a period (24 h, 7 days or 30 days) grouped by route, ship, day or machine. It only reads. Nothing on the page changes the fleet or a route.

**Provisional shapes.** Privateer has not shipped these yet, so Quarterdeck builds against guessed shapes and marks them provisional. Each is parsed in one place in `src/lib/shapes.ts`, with every field optional:

- `fleet.snapshot` gains per machine `routes: [ { name, harness, model, cost, state, until_ms?, resets_at?, last_error? } ]`. It is the same parser the fleet map uses (`parseSnapshot`).
- `routes.show {}` returns `{ routes: { <name>: { cost, note, options, manifest, allowance_resets_utc? } }, crew: [...], errand: [...], first_mate: [...] }`. The three lists are the order each tries routes in; the spend view uses the first list that names a route, crew first.
- `usage.summary { since_ms, until_ms?, group_by }` returns `{ since_ms, until_ms, group_by, groups: [ { key, jobs, usage: { input, output, cacheRead, cacheWrite, totalTokens } | null, gaps: [harness] } ] }`. A harness that reports nothing has its fields null and is named in `gaps`. `totalTokens` is the sum of the four as reported, or the reported value when Privateer sends one.

**Not reported.** Plan allowances and credit balances do not exist yet, so the view says "not reported" where they would go. No number is invented.

**Cache tokens** are shown apart from input and output, and labelled as cache. They are never presented as spend.

**Unsupported.** When the CLI refuses a command as unknown (`isUnknownCommand`), that section shows a calm "does not report … yet" state. Any other failure shows an error for that section only, so one failing read leaves the rest of the page up.

**Fixtures.** `fixtures/routes-show.json` and `fixtures/usage-records.json` stand in for Privateer. `FixtureSource` groups the records the way `usage.summary` would (`summarizeRecords` in `src/lib/usage.ts`), so a period or grouping switch changes the view in fixture mode too. A fixture's `resets_at` is shifted with the other `*_ms` times, so a capped route stays capped in the fixture.

**Sorting** (`buildRoutes` in `src/lib/spend.ts`). Throttled routes first (backing off or capped on any machine), then by try order, then by name. A route is listed even when no machine reports it, if `routes.show` names it.

**Switches** are plain links (`?period=…&group=…`), so the page works without JavaScript. The page re-runs its load every 60 s while the tab is visible, and on focus or when the tab becomes visible.

## 15. Reports: read in a sandbox, annotated by the captain

A ship can hand the captain a **report**: a long Markdown or HTML document. It arrives as `payload.report` on a request or a notice, either inline `{title, format, content}` (up to 256 KiB) or by reference `{title, format, report_id}`, which the portal fetches with `report.get {id}` from whichever home holds it. Reports appear in Triage and on Decisions with a "Report" marker and an "Open report" action; `/report/<key>` is the reader, where `<key>` is the ask key (sender and mail id, URL-encoded).

**The portal acts as the captain, so a report never runs in the portal's origin.** The reader embeds the report in an `iframe` with `srcdoc` and `sandbox="allow-scripts"`: no `allow-same-origin`, no top navigation, no forms, no popups. The document's Content Security Policy is `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-<random>'; base-uri 'none'; form-action 'none'`, set by a `<meta>` in the head that precedes any script or resource (it follows only the charset and viewport tags). Only the portal's own annotator carries the nonce, a fresh one per render, so the report's scripts do not run, and nothing loads from the network (an external image is refused by the CSP). The annotator sits in the head, ahead of the report, so a report cannot stop it from running. The document is built on the server (`src/lib/server/render.ts`).

**Staying on the report.** The sandbox still lets a frame navigate itself, and CSP does not stop that, so a report that could navigate its frame would put another document where the portal expects the annotator. Four layers stop it, each enough alone for what it covers:

1. _On the server_ (`defuse`), every `<meta>` element is removed from the report, whatever its attributes say, since `http-equiv="re&#102;resh"` is a refresh too once the parser decodes it. A tag name cannot be written with character references, so the match is on `<meta` followed by whitespace, `/` or `>`, in any case. The tags that could hide a link from the annotator are escaped to text: nested frames (an `iframe srcdoc` passes the frame's CSP, and its `target=_parent` links would navigate the frame), `object`, `embed`, `portal`, `fencedframe`, and `template` (a closed declarative shadow root keeps its links out of a click's path). A removal that joins text into a new tag is caught by the escape pass, which cannot make another; both passes are linear in the report's size.
2. _In the frame_, the annotator listens first (capture, on the window) and cancels any click or middle click whose path has an HTML `a` or `area`, an SVG `a` (with `href` or `xlink:href`), or any element with an `href`. Enter on a link is a click, so it is covered. Form submits and drops are cancelled too, though the sandbox already refuses forms.
3. _A per-render token._ Each render has a random token (separate from the CSP nonce), written into the annotator's script text, never into an attribute CSS could match. Every message the annotator sends carries it, and the portal drops any message without the current token. The portal never sends the token into the frame, so a document the frame was navigated to cannot learn it, and its messages, though they come from the same `contentWindow`, are dropped.
4. _Counting loads._ The portal builds the frame in the browser, with its sandbox and load listener in place before the srcdoc is set, so it sees every load. The first is the report; any later one means the frame was navigated. The portal then removes the frame, stops listening to it, and shows "This report tried to leave the page and was stopped", with a button that renders the report again (a fresh nonce and token). The comments are kept. Because the frame is built in the browser, the report does not show without JavaScript.

**Markdown** is rendered on the server with `marked`, the one runtime dependency this project has added. Raw HTML in Markdown is escaped and shown as text, never as markup; the frame's CSP is a second line of defence, not the first. Why `marked`: it is small, well known, renders GFM tables and code, and has a renderer hook that lets us escape raw HTML in one place. It does not sanitise, so the escape and the sandbox do the work. Links keep their `href` only for `http:`, `https:`, `mailto:` or a `#fragment`, checked on the URL as the browser reads it (spaces and controls around it, tabs and newlines in it, removed); anything else, `javascript:`, `data:`, `vbscript:` or a relative path, is shown as its text. Images keep their source only from `http(s)` (which the CSP then refuses), and otherwise show their alt text. The check is an allow list on a literal prefix, so character references cannot turn an allowed scheme into another.

**Messages** cross the frame boundary by `postMessage` only. The portal accepts a message only from the frame's own `contentWindow`, only with the current render's token (see above), and validates every field and length (`parseFromFrame` in `src/lib/report.ts`) before it uses it. The frame accepts messages only from its parent, and checks the type and size of each.

**Anchors.** A selected passage is `{quote, prefix, suffix}` (W3C text-quote style, with up to 32 characters of context either side). A tapped block is `{selector, quote}`: `selector` is the block's path of child indexes, and `quote` is its text. The frame flattens the report's text with a newline between blocks; the portal matches quotes on that text (`findQuote`). Where a quote occurs more than once, the occurrence whose context still matches wins. A comment whose text is gone is kept and shown as "No longer in the report", never dropped or moved.

**Highlights** use the CSS Custom Highlight API where the browser has it. Where it does not, the block containing the comment is tinted instead.

**Phone and desktop.** On desktop, select text and a "Comment" pop-up appears. On a phone, where selection is fiddly, tap a paragraph and a "Comment on this" pill appears. Both are inside the frame, so they are part of the frame's own script, and both need an explicit press, so a tap to read does not open a composer. The comments are a side column on desktop and a bottom sheet on a phone.

**Sending.** Every comment goes back as one `captain.reply {id, body, payload: {annotations: [{anchor, comment}]}}`, after a confirm step that shows the count. Up to 100 entries; each comment up to 4096 characters; each quote up to 2000. The body is "N comments on <title>", followed by the captain's optional note. The portal checks the list again on the server, since the client is not trusted. A report can be sent once: its record in the answers map says so, as it does for a decision. Nothing is sent unless `QD_SOURCE=cli` and `QD_ALLOW_SEND=1`; otherwise the exact arguments are logged.

**Drafts** are kept per report in `localStorage`, saved as the captain works, restored on return, and cleared only after a successful send. Storage that is refused is not an error: the comments still work for that visit.

**What is not done.** The frame's links do nothing, rather than opening anywhere. Nested frames and templates in an HTML report show as text. A report by id is fetched on each read; nothing is cached. Comments are not persisted on the server, so a draft lives in one browser until it is sent. The `report.get` shape is read as `{format, content}` at the top level or under `report`, which is a guess until Privateer's command lands; see `parseFetched` in `src/lib/server/source.ts`.

## 16. The Feed: one chat with the captain, built on a provisional `captain.feed`

The Feed is the landing page (`/` redirects to `/feed`). It is every message to and from the captain across ships and machines, drawn as a chat: newest at the bottom, older pages loaded on scroll-up, ship runs, date separators, and an Unread divider. Decisions moved to `/decisions` and keeps working. Triage and Fleet are unchanged.

**The wire shape is provisional.** Privateer's `captain.feed {after?, before?, limit?, ship?, include_ship_mail?}` is agreed in direction but not built. We read `{entries, more, next}`, which is our guess at the wrapper; the entry fields are as agreed: `machine, ship, id, created_ms, from, to, kind, correlation, task_id, urgency, deadline_ms, state, body, payload`. It is parsed in one place, `parseFeed` in `src/lib/shapes.ts`, with every field optional. `fixtures/captain.feed.json` is the stand-in. An older Privateer that does not know the command gives a calm "not on this Privateer yet" state, as Fleet and Spend do.

**Answering in place reuses the existing paths.** A decision or request is answered with the same `QuestionForm` as Decisions (`captain.reply`, the same send guard), a needs_hands step closes with Done (`captain.dismiss`), and a notice or report with Mark read or Open report. The feed's actions call the same `submitAnswer` and `submitDismiss` as the other pages. Nothing new writes to Privateer.

**An answer this portal sent appears before Privateer lists it.** `applyLocalAnswers` (`src/lib/feed.ts`) marks the ask answered or dismissed, and adds the captain's reply, marked "Logged, not sent" when nothing was sent. A reply Privateer already lists wins, so nothing shows twice.

**Scope.** The default is the captain's own mail. Ship-to-ship mail is behind a toggle, and a changed toggle or ship asks Privateer again, since it is Privateer that filters. "Only waiting on me" filters the messages already loaded; it does not ask Privateer for every open item, because `captain.feed` has no such filter yet.

**Identity of a message.** Messages are keyed by sender and id, as asks are (`askKey`), not by id alone: ships choose their own mail ids, so two ships can both send `b-1`. A desk copy and its original share both and appear once, the later version kept.

**Live.** The page polls `after` (the newest time on screen) every 10 s while the tab is visible, and again on focus. New messages append. If the captain is scrolled up, they are counted in a "N new messages" pill rather than moving the page. Scroll position is kept when older pages load. Typed answers survive polls, because each message is keyed and not remounted.

**Remembered per viewer** (`localStorage`, failures ignored): the filters, and where the captain last read. The Unread divider marks the point where the captain last read, and stays for that visit.

**Not done, by design.** System events (crew started or finished, merges) are not in the feed; `kind` and `payload` leave room for them. The ship page at `/ship/[name]` is a placeholder. Times are drawn only after the page runs, since the server's zone is not the captain's. The Feed badge shows the same count as Triage: open items waiting on the captain.
