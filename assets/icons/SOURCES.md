# Icon sources

Every icon in this directory is original work, drawn from scratch for this
repository by hand-writing the SVG path data. No icon set, font, clip art or
other artwork was copied, traced or adapted. They are licensed under the
repository's license, GPL-3.0-or-later (see `LICENSE` at the repository root).

| File           | Subject                         | Used for |
|----------------|---------------------------------|----------|
| `triage.svg`   | Ship's bell                     | Triage: what waits on the captain |
| `feed.svg`     | Signal hoist: flag and pennant  | Feed: the conversation with all ships |
| `ships.svg`    | Two-sailed ship                 | Ships |
| `fleet.svg`    | Compass with a north needle     | Fleet: the map of machines, ships and crew |
| `spend.svg`    | Treasure chest                  | Spend: model routes and usage |
| `reports.svg`  | Scroll (the captain's log)      | Reports |
| `settings.svg` | Ship's wheel                    | Settings |
| `app.svg`      | Ship cut out of a rounded tile  | App icon |
| `app-256.png`  | `app.svg` rendered at 256x256   | App icon (raster) |

## Style

- 24x24 viewBox, about 2px live margin.
- 2px stroke, round caps and joins, `fill="none"`, `stroke="currentColor"`;
  key lines sit on whole-pixel coordinates so they stay crisp at 16px. The
  compass needle's north half and the wheel's hub are filled with
  `currentColor`.
- `app.svg` is a single `currentColor` fill with the ship as a transparent
  cut-out (even-odd fill rule), so it reads at 16px as well as 256px.
- No hard-coded colours in the SVGs. `app-256.png` was rendered with
  `rsvg-convert` with `currentColor` set to the Ferra theme's
  `unread_indicator` (`#ffa07a`) on a transparent background.

`preview.html` shows every icon at 13, 16 and 32px on dark and light
backgrounds taken from `assets/themes/ferra.toml`; `preview.png` is a
headless Chromium screenshot of it at 1x.
