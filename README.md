# Quarterdeck

A native desktop app for the captain of a [Privateer](https://github.com/kirkins/privateer) fleet: see what every ship needs, and decide. It runs on your own machine, as you, and talks to Privateer through its JSON commands.

Status: early. A window with a sidebar of the captain's six views (Triage, Feed, Ships, Fleet, Spend, Reports), panes you can split, drag, resize and maximize, themes, and a settings window. Quarterdeck asks Privateer what waits on you every few seconds: the sidebar shows whether it answered, and Triage lists the open asks. The other views are placeholders.

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
```

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
- `data/src/privateer.rs`: running the privateer binary. `data/src/captain.rs`: what `captain.waiting` returns.
- `fixtures/`: invented data for `source = "fixtures"`.
- `src/appearance/`, `src/widget/`, `src/font.rs`, `src/icon.rs`, `src/window.rs`: the theme, widgets, fonts and window handling, from Halloy.
- `data/`: config, themes, the saved layout and window, with no UI.

## Credits

Quarterdeck builds on [Halloy](https://github.com/squidowl/halloy), the IRC client, and on halloy-extend, a fork of it. The theme system, widgets, font and icon handling and window persistence (`src/appearance/`, `src/widget/`, `src/font.rs`, `src/icon.rs`, `src/window.rs`, `data/src/appearance/`, `data/src/window/`) come from there, modified for Quarterdeck. It uses the same fork of [iced](https://github.com/iced-rs/iced) as Halloy. The bundled fonts are [Iosevka](https://github.com/be5invis/Iosevka) (SIL Open Font License) and Halloy's icon font built with [Fontello](https://fontello.com).

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
