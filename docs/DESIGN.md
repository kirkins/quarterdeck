# Quarterdeck design

Quarterdeck is opened many times a day, mostly on a phone, to answer one question: what needs me? Every choice below serves that. The nautical theme is seasoning, never costume: when clarity and theme disagree, clarity wins.

The tokens and shared components live in `src/app.css`; the page shell is `src/routes/+layout.svelte`.

## Principles

1. **What needs the captain is lifted; what is done recedes.** An open ask sits on a raised surface with a brass edge. A closed one loses its shadow and its ink gets quieter. Elevation and ink carry the hierarchy, so borders can be hairlines.
2. **One accent per meaning.** Sea-glass means act or selected: primary buttons, the chosen option, the current tab. Brass means waiting on you: badges, the "waiting" mark, the ship's recommendation. Red is only for overdue and errors. A colour never means two things.
3. **Thumbs first.** On a phone, navigation and the main action of the moment sit at the bottom of the screen. Every tap target is at least 44 px, even where the drawn button is smaller.
4. **Calm motion.** Things rise into place over 160 to 200 ms and never bounce. Nothing waits longer than 200 ms. `prefers-reduced-motion` turns animation off.

## Type

- **Fraunces** (variable, with optical sizes) for page titles, question headlines, machine names and the wordmark, which is set in italic. Its soft, slightly old-world serif gives the portal a voice of its own without getting in the way.
- **Inter** (variable) for everything else. It stays legible at 11 to 14 px, has tabular figures for counts and times, and renders the same on every platform, which the system fonts did not.
- Both are self-hosted through `@fontsource-variable` and bundled at build time. Nothing is fetched from a font service at runtime.
- Scale: 11, 12, 14, 15, 16, 18 and 22 px, then a fluid 26 to 30 px for section titles and 32 to 42 px for page titles. Small capitals (11 px, tracked 0.09 em) are kept for labels: kinds, section names, totals.

## Colour

Light is **chart paper**: a warm paper background, white surfaces, and deep navy ink. Dark is the **night watch**: deep navy with lit instruments, where surfaces get lighter as they rise and catch a faint highlight on their top edge.

| Token                         | Use                                           |
| ----------------------------- | --------------------------------------------- |
| `--bg`, `--surface`           | Page, and cards on it                         |
| `--surface-raised`            | What waits on the captain, inputs, popovers   |
| `--well`                      | Inset areas: segmented controls, meters, tags |
| `--ink`, `--ink-2`, `--ink-3` | Body text, secondary text, metadata           |
| `--sea`, `--sea-soft`         | Actions and selection                         |
| `--brass`, `--brass-fill`     | What waits on you, recommendations            |
| `--danger`, `--warn`, `--ok`  | Overdue and errors, due soon, done            |

Every text and background pair used in the components meets WCAG AA (4.5:1) in both themes; the lowest is `--ink-3` on `--well` in light, at 4.7:1. Status colours are always paired with words or icons, never colour alone.

## Space, shape and depth

- A 4 px grid (`--s-1` to `--s-16`). Cards pad 16 px on a phone and 24 px on a desktop.
- Radii step from 4 px (code) through 8, 12 and 16 px to 22 px for the largest cards, so nested shapes stay concentric.
- Three elevations. `--elev-1` is a hairline and a whisper of shadow for resting cards, `--elev-2` is for what waits on you and for open panels, and `--elev-3` is for things that float: toasts, the sticky confirm bar, the "new messages" pill.

## Navigation

One `<nav aria-label="Sections">`, drawn two ways:

- **Phone** (under 60 rem): a tab bar fixed to the bottom with Feed, Triage, Decisions, Fleet and Spend. Five destinations fit at 320 px, so there is no "More" menu and nothing is hidden. The top bar holds only the mark, the theme button, Sign out (an icon, when login is on) and, when answers are not sent, the fixture or dry-run notice; it scrolls away.
- **Desktop**: a quiet sidebar with the same links, the notice and the theme button (system, light, dark) at the foot, and under a hairline, a green "Signed in" dot with **Sign out** beside it when login is on.

Badges show what waits on the captain: a brass count on Triage, a brass dot on Feed (the same items, so the number is not repeated), and a neutral count on Decisions while it is open. `--dock` holds the tab bar's height, so floating things (toasts, the "new messages" pill, the report's comment sheet, the confirm bar) sit above it on a phone and at the bottom on a desktop.

## Components

| Component                                                             | Where                                                       |
| --------------------------------------------------------------------- | ----------------------------------------------------------- |
| `PageHeader`                                                          | Every page: display title, summary line, actions            |
| `EmptyState`                                                          | Calm (a horizon), quiet (not offered here) and error states |
| `RefreshButton`                                                       | Decisions, Triage, Fleet and Spend                          |
| `Skeleton`                                                            | Shown while a slow page loads, after 180 ms                 |
| `Toaster` and `toast()`                                               | Confirms answers, replies, dismissals and sent comments     |
| `Icon`                                                                | Line icons on a 24 px grid, one stroke weight, no library   |
| `.btn`, `.chip`, `.segmented`, `.tag`, `.count`, `.callout`, `.field` | Global classes in `app.css`                                 |

The summary line under each title puts what needs the captain first, marked in brass, followed by plain facts. Separators that would start a wrapped line are clipped away.

## Interaction

- **Confirm, then send.** Picking an option or writing an answer opens a confirm step; on a phone it sticks above the tab bar while the card scrolls, so Send is always in reach. Dismissing goes through the same kind of step.
- **Sent state.** A toast says what happened in words ("Answer sent to billing", or "logged · not sent" when the portal is not sending), and the ask itself closes in place with its outcome. Toasts are polite live regions with no `status` role, so they never stand in for the status shown on the ask.
- **No undo.** A reply to a ship cannot be taken back, so there is no undo that would pretend otherwise. The confirm step is the safeguard instead.
- **Optimistic where it already was.** The Feed closes an answered ask in place, as before. Triage replies now use the same enhanced form as everything else, so the page updates without a reload.

## Nautical seasoning

- A faint chart grid behind every page, 72 px squares at about 3 % ink.
- The compass mark, and the italic Fraunces wordmark beside it.
- Thin rules: crew hang off their ship on a hairline like entries in a log, and day separators are labelled like soundings on a chart.
- Empty states show a horizon at sunrise rather than a stock illustration.
- The palette: navy, sea-glass and brass.

## Signing in

The login page stands alone: no navigation, nothing from the fleet, only the theme button in the corner. One card, centred on the chart grid, lifted like an ask and edged in brass: the mark and wordmark, a small-caps "The captain's portal", the display title **Come aboard**, and one line on why it matters. Then one field, the passphrase, with a show/hide eye inside it (44 px, `aria-pressed`), and a full-width sea-glass **Sign in** that reads "Checking…" with a spinner while the server works. A wrong passphrase gets a red callout and a red edge on the field, and says only that it did not work; a lockout gets a warning callout that says how long to wait. Signing out lands back here with a green "Signed out" note. A hairline footer says how long a session lasts. Screenshots: `docs/screenshots/login-*.png`.

## Reports

The report frame is sandboxed and its CSP allows no fonts, so it uses the system sans for text and a system serif stack (Iowan Old Style, Palatino, Georgia) for headings, in the same colours as the portal.
