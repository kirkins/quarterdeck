# Quarterdeck

A native desktop app for the captain of a [Privateer](https://github.com/kirkins/privateer) fleet: see what every ship needs, and decide. It runs on your own machine, as you, and talks to Privateer through its JSON commands.

Status: early. A window with a sidebar of the captain's views (Triage, Feed, Ships, Fleet, Spend, Reports, Live), panes you can split, drag, resize and maximize, themes, and a settings window. Quarterdeck asks Privateer what waits on you every few seconds: the sidebar shows whether it answered, and Triage lists the open asks. Triage sorts what waits on you into "Needs you now", "Waiting on you" and "When you have a moment" (high urgency, then overdue, then the nearest deadline, then the oldest). Decisions open as cards: the question, why it matters as Markdown, the options with cost and the ship's recommendation, and always a way to answer in your own words. Answering is two steps, choose then confirm; any ask can be dismissed, with a note. The Feed is every message to and from you across ships and machines, oldest at the top: day separators, Markdown bodies, the state of each ask, and an Answer button that opens the answer controls right under an open ask, the same ones Triage uses. It reads Privateer's `captain.feed` by cursor (newest page first, new mail on each poll, Load older for more), places a message by its time and keys it by sender and id, so a copy collected late from another machine lands where it was written and never twice. At the bottom of the Feed you write to any ship in the fleet (the ships come from `ship.list`): pick the ship, write, tick "Ask for an answer" for a request rather than a notice, and confirm. It goes through the same guarded path as answers, as Privateer's `captain.send` (Privateer PR #258), which writes from the captain's desk wherever it is. Attach adds files through the desktop's file chooser, and a file dropped onto the window goes to the composer in view (on macOS, Windows and X11; winit gives Wayland windows no drops yet). Privateer mail carries no files, so a file goes the way the Telegram door sends one: copied into the data directory (`attachments/`) when the message is sent, with its path in the message. A path is good only on this machine, so files go only to a ship that runs here, by the fleet as last read; up to 10 files of at most 50 MB each. Reports are a ship's long documents (`payload.report`, inline or stored and read with `report.get`): "Open report" on an ask or a message opens it in the Reports pane, drawn as Markdown, where each block takes a comment. The comments go back to the ship as one `captain.reply` with `payload.annotations`, after a confirm, through the same guarded path. A comment is written in a box of its own lines. Comments are drafts kept per report in the data directory (`report-drafts.json`), so they survive a restart, and are cleared only once sent. Comments already sent stay under the blocks they were on, read from the report's thread in the feed and from `report-sent.json` for those sent from here, since the captain's desk does not always hold the reply; one whose block is gone is listed above the report with its quote. On a request or decision the reader says that sending the comments answers it and closes it. A report stored on another machine says so instead of erroring. HTML reports are not drawn; their source can be shown. Live shows a ship's first mate as it works: pick a ship and its live session's terminal screen appears with its colours, read every second while the pane is on screen and redrawn only when it changes, with a line to type into it and Esc, Ctrl-C and Enter. Typing is a write, so it reaches the session only with sending on. It uses Privateer's `session.read` and `session.send` (Privateer PR #262), which find the ship's terminal host pane wherever it runs. Live's list is the fleet's tree: machine, then ship, then each crew with a session of its own (Privateer PR #271), which Live shows the same way; for a headless crew it is a view of its run, and typed lines go to its first mate. Fleet shows every machine, its ships and their crew from `fleet.snapshot`, with a Watch button on hosted first mates and live crew. Ships is one first mate at a time: its conversation with you (Privateer's `captain.feed` narrowed to that ship, with its ship-to-ship and crew mail on a tick), answered in place as in the Feed; who it is, its open tasks, the tools its profile gives it (from `ship.profile`, secrets masked), its crew with Watch buttons; and a composer that writes to it. A ship's name in the Feed or Fleet opens it there. Spend shows the model routes in the order crew try them, each with its state now from `fleet.snapshot`, and the tokens used over the last 24 hours, 7 days or 30 days, grouped by route, ship, day or machine, from `usage.summary`. Cache tokens are shown apart and never as spend; what Privateer does not report is said to be not reported.

**Sending is off until you turn it on.** Every answer and dismissal goes through one path: unless `source = "cli"` and `allow_send = true`, nothing runs, the exact command is logged, and the ask is marked "not sent". Replies use `captain.reply {id, body, payload: {answer}}`: an option is `{option_id}`, with a note `{option_id, text}`, your own words `{text}`. Dismissing is `captain.dismiss {id, note?}`.

The earlier SvelteKit web portal is archived on the [`archive/sveltekit`](https://github.com/kirkins/quarterdeck/tree/archive/sveltekit) branch (tag `sveltekit-final`). Its [design](https://github.com/kirkins/quarterdeck/blob/archive/sveltekit/docs/DESIGN.md) and [decisions](https://github.com/kirkins/quarterdeck/blob/archive/sveltekit/docs/DECISIONS.md) are the spec this app is catching up to.

## Run it

Requires a recent stable Rust (developed on 1.99). On Linux, the system libraries in [.github/linux-deps.txt](.github/linux-deps.txt).

```sh
cargo run
```

The first build compiles iced and wgpu and takes a while.

## Configuration

Everything is optional. Quarterdeck reads `config.toml` from its config directory (`~/.config/quarterdeck` on Linux, `~/Library/Application Support/quarterdeck` on macOS, or `~/.config/quarterdeck` there too if that has a config file). A `config.toml` beside the executable makes it portable.

```toml
theme = "ferra"                               # or { light = "paper", dark = "ferra" } to follow the system
scale_factor = 1.0

[font]
family = "Iosevka Term"
size = 13
weight = "normal"

[sidebar]
position = "left"                             # or "right"
width = 220

[privateer]
home = "~/ships/workstation/.privateer"       # any Privateer home on this machine
bin = "privateer"                             # a path, or a name on PATH
source = "cli"                                # or "fixtures" for invented data
poll_seconds = 15                             # at least 5
allow_send = false                            # true to really send answers

[notifications]
enabled = true                                # default: on for "cli", off for "fixtures"
```

When an ask newly needs you now (high urgency, or a deadline within a day), Quarterdeck shows a desktop notification: the ship and what it asks, or a count and the first few when several arrive together. Each ask is announced once, whether it arrived urgent or became urgent as its deadline drew near. What already waits when Quarterdeck starts is not announced.

Quarterdeck runs `privateer --home HOME COMMAND --json ARGS` as the captain: it clears `PRIVATEER_ACTOR`, `PRIVATEER_ROLE` and `PRIVATEER_HOME`, so starting it from a ship's shell does not make it act as that ship. Each command runs in its own process group, with a time limit and an output limit, and is stopped with everything it started when it runs over. When `privateer machine captain` keeps the captain's desk on another machine, Privateer answers the captain's commands from there (Privateer PR #251).

Themes are Halloy themes: `.toml` files in `themes/` beside the config. The settings window picks the theme and sidebar side and writes them back to `config.toml`, keeping the rest of the file and its comments. The window position and the pane layout are saved in the data directory (`~/.local/share/quarterdeck`).

## Develop

```sh
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Layout:

- `src/main.rs`: the app: windows, messages, saving on close.
- `src/screen/dashboard.rs`: the sidebar and the pane grid.
- `src/screen/settings.rs`: the settings window.
- `src/connection.rs`: polling Privateer, and what it last answered.
- `src/screen/feed.rs` and `data/src/feed.rs`: the Feed, and the conversation read by cursor.
- `data/src/attachment.rs`: files sent with a message, and which ships they reach.
- `src/screen/triage.rs`: the Triage view, decision cards, answering and dismissing.
- `data/src/alert.rs` and `src/notification.rs`: which asks newly need you now, and the desktop notification.
- `data/src/triage.rs`: sections and order. `data/src/decision.rs`: an ask as a card, and the reply and dismiss arguments.
- `data/src/privateer.rs`: running the privateer binary, and the one guarded write path. `data/src/captain.rs`: what `captain.waiting` returns.
- `data/src/markdown.rs` and `src/widget/markdown.rs`: Markdown into a document model, and drawing it. Ported from halloy-extend's Doc Lib parser and extension rich-text blocks; inline `$...$` math is not read, so prices stay text.
- `src/screen/reports.rs` and `data/src/report.rs`: the report reader, and comments within Privateer's limits.
- `src/screen/live.rs` and `data/src/ansi.rs`: the Live view, and a terminal screen's colours.
- `src/screen/ships.rs`: the Ships view, one ship's conversation and work, built on the Feed's conversation.
- `fixtures/`: invented data for `source = "fixtures"`.
- `src/appearance/`, `src/widget/`, `src/font.rs`, `src/icon.rs`, `src/window.rs`: the theme, widgets, fonts and window handling, from Halloy.
- `data/`: config, themes, the saved layout and window, with no UI.

## Credits

Quarterdeck builds on [Halloy](https://github.com/squidowl/halloy), the IRC client, and on halloy-extend, a fork of it. The theme system, widgets, font and icon handling and window persistence (`src/appearance/`, `src/widget/`, `src/font.rs`, `src/icon.rs`, `src/window.rs`, `data/src/appearance/`, `data/src/window/`) come from there, modified for Quarterdeck, as does the Markdown parser and renderer. It uses the same fork of [iced](https://github.com/iced-rs/iced) as Halloy. The bundled fonts are [Iosevka](https://github.com/be5invis/Iosevka) (SIL Open Font License) and Halloy's icon font built with [Fontello](https://fontello.com).

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
