//! Draws a `data::markdown::Document`. Adapted from halloy-extend's
//! extension rich-text blocks (`runtime_rich_text_block_view`).

use data::appearance::theme::FontStyle;
use data::markdown::{Document, Node, Span};
use iced::widget::{column, container, image, rich_text, row, span};
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

fn node_view<'a, Message>(
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
                    .align_x(iced::alignment::Horizontal::Right),
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
