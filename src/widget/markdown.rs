//! Draws a `data::markdown::Document`. Adapted from halloy-extend's
//! extension rich-text blocks (`runtime_rich_text_block_view`).

use data::appearance::theme::FontStyle;
use data::markdown::{Align, Document, Node, Span};
use iced::alignment::Horizontal;
use iced::widget::text::Wrapping;
use iced::widget::{
    column, container, image, responsive, rich_text, row, scrollable, span,
    table,
};
use iced::{Alignment, Length};

use super::{Element, Renderer, text};
use crate::appearance::theme;
use crate::{Theme, font};

type RichSpan<'a> = iced::widget::text::Span<
    'a,
    String,
    <Renderer as iced::advanced::text::Renderer>::Font,
>;

/// The document; a link press sends its URL through `on_link`.
pub fn markdown<'a, Message>(
    document: &'a Document,
    theme: &Theme,
    on_link: fn(String) -> Message,
) -> Element<'a, Message>
where
    Message: Clone + 'a,
{
    column(
        document
            .nodes
            .iter()
            .map(|node| node_view(node, theme, on_link)),
    )
    .spacing(10)
    .width(Length::Fill)
    .into()
}

/// One block of a document, for a view that lays blocks out itself.
pub fn node_view<'a, Message>(
    node: &'a Node,
    theme: &Theme,
    on_link: fn(String) -> Message,
) -> Element<'a, Message>
where
    Message: Clone + 'a,
{
    match node {
        Node::Heading { level, spans } => {
            inline(spans, theme, heading_size(*level), true, on_link)
        }
        Node::Paragraph(spans) => {
            inline(spans, theme, theme::TEXT_SIZE, false, on_link)
        }
        Node::Quote(spans) => row![
            container(text(" ")).width(3).height(Length::Fill).style(
                |theme: &Theme| container::Style {
                    background: Some(theme.styles().general.border.into()),
                    ..Default::default()
                }
            ),
            container(inline(spans, theme, theme::TEXT_SIZE, false, on_link))
                .width(Length::Fill),
        ]
        .spacing(10)
        .height(Length::Shrink)
        .into(),
        Node::List {
            ordered,
            start,
            items,
        } => column(items.iter().enumerate().map(|(index, item)| {
            let marker = if *ordered {
                format!("{}.", start + index)
            } else {
                "•".to_owned()
            };
            row![
                container(text(marker).style(theme::text::secondary))
                    .width(24)
                    .align_x(Horizontal::Right),
                container(inline(
                    item,
                    theme,
                    theme::TEXT_SIZE,
                    false,
                    on_link
                ))
                .width(Length::Fill),
            ]
            .spacing(8)
            .align_y(Alignment::Start)
            .into()
        }))
        .spacing(6)
        .into(),
        Node::CodeBlock { language, lines } => {
            let mut content = column![].spacing(4);
            if let Some(language) =
                language.as_deref().filter(|l| !l.trim().is_empty())
            {
                content = content.push(
                    text(language)
                        .style(theme::text::tertiary)
                        .size(theme::TEXT_SIZE - 1.0),
                );
            }
            content = content.push(
                text(lines.join("\n"))
                    .style(|theme: &Theme| iced::widget::text::Style {
                        color: Some(theme.styles().buffer.code.color),
                    })
                    .font(font::MONO.clone()),
            );
            container(content)
                .padding(10)
                .width(Length::Fill)
                .style(|theme| theme::container::buffer(theme, false))
                .into()
        }
        Node::Rule => container(text(" ").size(1))
            .width(Length::Fill)
            .height(1)
            .style(|theme: &Theme| container::Style {
                background: Some(theme.styles().general.border.into()),
                ..Default::default()
            })
            .into(),
        Node::Table {
            alignments,
            header,
            rows,
        } => {
            let measures = (0..header.len())
                .map(|index| {
                    Measure::of(
                        std::iter::once(&header[index])
                            .chain(rows.iter().map(|row| &row[index])),
                    )
                })
                .collect::<Vec<_>>();
            let theme = theme.clone();
            responsive(move |size| {
                let theme = &theme;
                let (widths, fits) = column_widths(&measures, size.width);
                let columns = header
                    .iter()
                    .zip(alignments)
                    .zip(widths)
                    .enumerate()
                    .map(|(index, ((header, align), width))| {
                        let align = match align {
                            Align::Left => Horizontal::Left,
                            Align::Center => Horizontal::Center,
                            Align::Right => Horizontal::Right,
                        };
                        table::column(
                            cell(header, theme, true, align, on_link),
                            move |row: &'a Vec<Vec<Span>>| {
                                cell(&row[index], theme, false, align, on_link)
                            },
                        )
                        .width(width)
                    });
                let table =
                    table(columns, rows).padding_x(CELL_PADDING).padding_y(5);
                if fits {
                    table.into()
                } else {
                    // Too many columns to wrap into the view: scroll it.
                    scrollable(table)
                        .direction(scrollable::Direction::Horizontal(
                            scrollable::Scrollbar::default(),
                        ))
                        .spacing(4)
                        .into()
                }
            })
            .height(Length::Shrink)
            .into()
        }
        Node::Image { path, caption } => {
            let mut content =
                column![image(path.clone()).width(Length::Shrink)].spacing(4);
            if let Some(caption) = caption {
                content = content
                    .push(text(caption.as_str()).style(theme::text::secondary));
            }
            content.into()
        }
    }
}

fn inline<'a, Message>(
    spans: &'a [Span],
    theme: &Theme,
    size: f32,
    bold: bool,
    on_link: fn(String) -> Message,
) -> Element<'a, Message>
where
    Message: Clone + 'a,
{
    rich_text(
        spans
            .iter()
            .map(|data| rich_span(data, theme, bold))
            .collect::<Vec<_>>(),
    )
    .size(size)
    .line_height(font::line_height())
    .on_link_click(on_link)
    .width(Length::Fill)
    .into()
}

const CELL_PADDING: f32 = 10.0;
/// The widest a column grows before its text wraps.
const COLUMN_MAX: f32 = 360.0;
/// The narrowest a column of long words shrinks to; longer words break.
const WORD_MAX: f32 = 160.0;
/// The narrowest a column shrinks to when even its words do not fit.
const COLUMN_MIN: f32 = 48.0;

/// A table column's text in pixels: on one line, and its longest word.
/// Text is not measured until layout, so this guesses from the characters,
/// on the wide side, so a cell given this much does not overflow.
struct Measure {
    line: f32,
    word: f32,
}

impl Measure {
    fn of<'a>(cells: impl Iterator<Item = &'a Vec<Span>>) -> Self {
        let char_width = theme::TEXT_SIZE * 0.62;
        let (line, word) = cells.fold((0, 0), |(line, word), cell| {
            let text = cell
                .iter()
                .map(|span| span.text.as_str())
                .collect::<String>();
            let longest_word = text
                .split_whitespace()
                .map(|word| word.chars().count())
                .max()
                .unwrap_or(0);
            (line.max(text.chars().count()), word.max(longest_word))
        });
        let line = (line as f32 * char_width).ceil();
        Measure {
            line: line.min(COLUMN_MAX),
            word: (word as f32 * char_width).ceil().min(WORD_MAX).min(line),
        }
    }
}

/// Each column's width in `available`, and whether the table fits: every
/// column as wide as its text when there is room, else each shrunk toward
/// its longest word in proportion to how much it would wrap, else each
/// shrunk in proportion to its longest word, breaking words, down to a few
/// characters; only a table too wide even for that scrolls.
fn column_widths(measures: &[Measure], available: f32) -> (Vec<f32>, bool) {
    let spacing = (CELL_PADDING * 2.0 + 1.0) * measures.len() as f32;
    let available = available - spacing;
    let lines = measures.iter().map(|m| m.line).sum::<f32>();
    let words = measures.iter().map(|m| m.word).sum::<f32>();
    let floor = |m: &Measure| m.word.min(COLUMN_MIN);

    if lines <= available {
        (measures.iter().map(|m| m.line).collect(), true)
    } else if words <= available {
        let share = (available - words) / (lines - words);
        (
            measures
                .iter()
                .map(|m| (m.word + (m.line - m.word) * share).floor())
                .collect(),
            true,
        )
    } else if measures.iter().map(floor).sum::<f32>() <= available {
        let share = available / words;
        let widths = measures
            .iter()
            .map(|m| (m.word * share).floor().max(floor(m)))
            .collect::<Vec<_>>();
        // The floors can take more than their share: take it back from
        // the columns above theirs.
        let over = widths.iter().sum::<f32>() - available;
        let above = measures
            .iter()
            .zip(&widths)
            .map(|(m, w)| w - floor(m))
            .sum::<f32>();
        (
            measures
                .iter()
                .zip(widths)
                .map(|(m, w)| {
                    if over > 0.0 && above > 0.0 {
                        (w - (w - floor(m)) * over / above).floor()
                    } else {
                        w
                    }
                })
                .collect(),
            true,
        )
    } else {
        (measures.iter().map(floor).collect(), false)
    }
}

/// A table cell, wrapping in the width of its column.
fn cell<'a, Message>(
    spans: &'a [Span],
    theme: &Theme,
    bold: bool,
    align: Horizontal,
    on_link: fn(String) -> Message,
) -> Element<'a, Message>
where
    Message: Clone + 'a,
{
    rich_text(
        spans
            .iter()
            .map(|data| rich_span(data, theme, bold))
            .collect::<Vec<_>>(),
    )
    .size(theme::TEXT_SIZE)
    .line_height(font::line_height())
    .wrapping(Wrapping::WordOrGlyph)
    .align_x(align)
    .on_link_click(on_link)
    .into()
}

fn rich_span<'a>(data: &'a Span, theme: &Theme, bold: bool) -> RichSpan<'a> {
    let styles = theme.styles();
    let mut rich = span(data.text.as_str()).strikethrough(data.strikethrough);

    if data.code {
        rich = rich
            .padding([0, 4])
            .color(styles.buffer.code.color)
            .border(
                iced::border::rounded(3)
                    .color(styles.general.border)
                    .width(1),
            )
            .font_maybe(styles.buffer.code.font_style.map(font::get));
    } else {
        rich = rich.font(font::get(FontStyle::new(
            bold || data.strong,
            data.emphasis,
        )));
    }

    if let Some(url) = data.url.as_deref().filter(|url| !url.trim().is_empty())
    {
        rich = rich
            .link(url.to_owned())
            .underline(true)
            .color(styles.buffer.url.color);
    }

    rich
}

fn heading_size(level: u8) -> f32 {
    theme::TEXT_SIZE
        + match level {
            1 => 8.0,
            2 => 6.0,
            3 => 4.0,
            4 => 2.0,
            _ => 1.0,
        }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn measure(line: f32, word: f32) -> Measure {
        Measure { line, word }
    }

    #[test]
    fn tables_fit_the_view_before_they_scroll() {
        let measures = [measure(10.0, 10.0), measure(300.0, 80.0)];
        let spacing = (CELL_PADDING * 2.0 + 1.0) * 2.0;

        // Room for every line.
        assert_eq!(
            column_widths(&measures, 400.0 + spacing),
            (vec![10.0, 300.0], true)
        );
        // Long text wraps; the short column keeps its width.
        let (widths, fits) = column_widths(&measures, 200.0 + spacing);
        assert!(fits);
        assert_eq!(widths[0], 10.0);
        assert!(widths.iter().sum::<f32>() <= 200.0);
        // Words break, down to a floor.
        let (widths, fits) = column_widths(&measures, 70.0 + spacing);
        assert!(fits);
        assert!(widths.iter().sum::<f32>() <= 70.0);
        assert!(widths[1] >= COLUMN_MIN);
        // Narrower than the floors: it scrolls.
        assert!(!column_widths(&measures, 20.0 + spacing).1);
    }
}
