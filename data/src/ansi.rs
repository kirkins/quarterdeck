//! A terminal screen with ANSI colours, as `session.read` returns it, read
//! into lines of styled runs. Only SGR (colour and weight) is kept; any other
//! escape sequence is dropped, since the host has already laid the screen
//! out.

/// A colour as the terminal named it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Colour {
    /// One of the 16 standard colours, 0-15.
    Indexed(u8),
    /// One of the 256-colour palette's, 16-255.
    Palette(u8),
    Rgb(u8, u8, u8),
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Style {
    pub fg: Option<Colour>,
    pub bg: Option<Colour>,
    pub bold: bool,
    pub dim: bool,
    pub italic: bool,
    pub underline: bool,
    pub inverse: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
    pub text: String,
    pub style: Style,
}

/// The screen as lines of runs. Style carries across line ends, as on a
/// terminal.
pub fn parse(screen: &str) -> Vec<Vec<Run>> {
    let mut lines = Vec::new();
    let mut style = Style::default();
    for raw in screen.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        let mut runs: Vec<Run> = Vec::new();
        let mut text = String::new();
        let mut chars = raw.chars().peekable();
        while let Some(c) = chars.next() {
            if c != '\u{1b}' {
                if !c.is_control() || c == '\t' {
                    text.push(c);
                }
                continue;
            }
            match chars.peek() {
                Some('[') => {
                    chars.next();
                    let mut params = String::new();
                    let mut end = None;
                    for c in chars.by_ref() {
                        if ('\u{40}'..='\u{7e}').contains(&c) {
                            end = Some(c);
                            break;
                        }
                        params.push(c);
                    }
                    if end == Some('m') {
                        flush(&mut runs, &mut text, style);
                        apply(&mut style, &params);
                    }
                }
                Some(']') => {
                    // OSC, up to BEL or ST: a title or a link, not text.
                    chars.next();
                    while let Some(c) = chars.next() {
                        if c == '\u{7}'
                            || (c == '\u{1b}'
                                && chars.next_if_eq(&'\\').is_some())
                        {
                            break;
                        }
                    }
                }
                _ => {
                    chars.next();
                }
            }
        }
        flush(&mut runs, &mut text, style);
        lines.push(runs);
    }
    lines
}

fn flush(runs: &mut Vec<Run>, text: &mut String, style: Style) {
    if text.is_empty() {
        return;
    }
    let text = std::mem::take(text);
    match runs.last_mut() {
        Some(last) if last.style == style => last.text.push_str(&text),
        _ => runs.push(Run { text, style }),
    }
}

fn apply(style: &mut Style, params: &str) {
    let codes: Vec<u16> = if params.is_empty() {
        vec![0]
    } else {
        params
            .split([';', ':'])
            .map(|p| p.parse().unwrap_or(0))
            .collect()
    };
    let mut i = 0;
    while i < codes.len() {
        match codes[i] {
            0 => *style = Style::default(),
            1 => style.bold = true,
            2 => style.dim = true,
            3 => style.italic = true,
            4 => style.underline = true,
            7 => style.inverse = true,
            22 => {
                style.bold = false;
                style.dim = false;
            }
            23 => style.italic = false,
            24 => style.underline = false,
            27 => style.inverse = false,
            n @ 30..=37 => style.fg = Some(Colour::Indexed((n - 30) as u8)),
            n @ 90..=97 => style.fg = Some(Colour::Indexed((n - 90 + 8) as u8)),
            39 => style.fg = None,
            n @ 40..=47 => style.bg = Some(Colour::Indexed((n - 40) as u8)),
            n @ 100..=107 => {
                style.bg = Some(Colour::Indexed((n - 100 + 8) as u8))
            }
            49 => style.bg = None,
            n @ (38 | 48) => {
                let colour = match codes.get(i + 1) {
                    Some(5) => {
                        let index =
                            codes.get(i + 2).copied().unwrap_or(0).min(255)
                                as u8;
                        i += 2;
                        Some(if index < 16 {
                            Colour::Indexed(index)
                        } else {
                            Colour::Palette(index)
                        })
                    }
                    Some(2) => {
                        let channel = |k| {
                            codes.get(i + k).copied().unwrap_or(0).min(255)
                                as u8
                        };
                        let rgb =
                            Colour::Rgb(channel(2), channel(3), channel(4));
                        i += 4;
                        Some(rgb)
                    }
                    _ => None,
                };
                if n == 38 {
                    style.fg = colour;
                } else {
                    style.bg = colour;
                }
            }
            _ => {}
        }
        i += 1;
    }
}

/// A palette colour as RGB, for the 256-colour cube and grey ramp.
pub fn palette_rgb(index: u8) -> (u8, u8, u8) {
    match index {
        16..=231 => {
            let n = index - 16;
            let level = |v: u8| if v == 0 { 0 } else { 55 + v * 40 };
            (level(n / 36), level((n / 6) % 6), level(n % 6))
        }
        232..=255 => {
            let grey = 8 + (index - 232) * 10;
            (grey, grey, grey)
        }
        _ => (0, 0, 0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_and_weight_carry_until_reset_and_other_escapes_drop() {
        let lines = parse(
            "\u{1b}[1mpi\u{1b}[0m ready\r\n\u{1b}[38;5;208mwarm\u{1b}[39m \
             \u{1b}[38;2;1;2;3mrgb\n\u{1b}[2Kstill rgb\u{1b}]0;title\u{7}!",
        );

        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0][0].text, "pi");
        assert!(lines[0][0].style.bold);
        assert_eq!(lines[0][1].text, " ready");
        assert_eq!(lines[0][1].style, Style::default());
        assert_eq!(lines[1][0].style.fg, Some(Colour::Palette(208)));
        assert_eq!(lines[1][1].style.fg, None);
        assert_eq!(lines[1][2].style.fg, Some(Colour::Rgb(1, 2, 3)));
        // A cursor or erase sequence and a window title are not text; the
        // colour set on the line before still holds.
        assert_eq!(lines[2][0].text, "still rgb!");
        assert_eq!(lines[2][0].style.fg, Some(Colour::Rgb(1, 2, 3)));
    }

    #[test]
    fn the_256_colour_cube_and_grey_ramp() {
        assert_eq!(palette_rgb(16), (0, 0, 0));
        assert_eq!(palette_rgb(196), (255, 0, 0));
        assert_eq!(palette_rgb(255), (238, 238, 238));
    }
}
