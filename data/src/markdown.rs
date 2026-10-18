//! Markdown into a small document model: headings, paragraphs, lists,
//! quotes, code blocks, rules and images, with bold, italic, code,
//! strikethrough and links inline. Ported from halloy-extend's Doc Lib
//! (`render_markdown_blocks` in its pdf-runtime helper).
//!
//! Ships write Markdown, so this covers what they write rather than all of
//! CommonMark. Inline `$...$` math is not read, since ships often write
//! prices (`$40/mo`); `$$` display math is kept as a code block.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Document {
    pub nodes: Vec<Node>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Node {
    Heading {
        level: u8,
        spans: Vec<Span>,
    },
    Paragraph(Vec<Span>),
    List {
        ordered: bool,
        start: usize,
        items: Vec<Vec<Span>>,
    },
    Quote(Vec<Span>),
    CodeBlock {
        language: Option<String>,
        lines: Vec<String>,
    },
    Rule,
    /// A local image that exists, with its alt text as caption.
    Image {
        path: PathBuf,
        caption: Option<String>,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Span {
    pub text: String,
    pub strong: bool,
    pub emphasis: bool,
    pub code: bool,
    pub strikethrough: bool,
    pub url: Option<String>,
}

impl Document {
    /// The text without formatting, blocks separated by blank lines.
    pub fn plain_text(&self) -> String {
        let spans = |spans: &[Span]| {
            spans.iter().map(|s| s.text.as_str()).collect::<String>()
        };
        self.nodes
            .iter()
            .filter_map(|node| match node {
                Node::Heading { spans: s, .. }
                | Node::Paragraph(s)
                | Node::Quote(s) => Some(spans(s)),
                Node::List { items, .. } => Some(
                    items
                        .iter()
                        .map(|item| spans(item))
                        .collect::<Vec<_>>()
                        .join("\n"),
                ),
                Node::CodeBlock { lines, .. } => Some(lines.join("\n")),
                Node::Rule => None,
                Node::Image { caption, .. } => caption.clone(),
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    }
}

/// Parse Markdown. Relative links and images resolve against `base`, the
/// folder of the file the Markdown came from; without one (a message body)
/// only absolute URLs become links.
pub fn parse(markdown: &str, base: Option<&Path>) -> Document {
    let mut nodes = Vec::new();
    let lines = markdown.lines().collect::<Vec<_>>();
    let mut index = 0;

    while index < lines.len() {
        let line = lines[index];
        let trimmed = line.trim();

        if trimmed.is_empty() {
            index += 1;
            continue;
        }

        if let Some((alt, dest)) = parse_standalone_image_line(trimmed) {
            nodes.push(image_or_link(base, &alt, &dest));
            index += 1;
            continue;
        }

        if let Some((math, consumed)) =
            parse_display_math_block(&lines[index..])
        {
            nodes.push(Node::CodeBlock {
                language: Some("math".into()),
                lines: math,
            });
            index += consumed;
            continue;
        }

        if let Some(fence) = parse_fence_start(trimmed) {
            let mut code = Vec::new();
            index += 1;
            while index < lines.len() {
                if is_fence_end(lines[index].trim(), &fence) {
                    index += 1;
                    break;
                }
                code.push(lines[index].to_owned());
                index += 1;
            }
            nodes.push(Node::CodeBlock {
                language: fence.language,
                lines: code,
            });
            continue;
        }

        if is_thematic_break(trimmed) {
            nodes.push(Node::Rule);
            index += 1;
            continue;
        }

        if let Some((level, text)) = parse_heading_line(trimmed) {
            nodes.push(Node::Heading {
                level,
                spans: parse_inline(text, base),
            });
            index += 1;
            continue;
        }

        if trimmed.starts_with('>') {
            let start = index;
            while index < lines.len()
                && lines[index].trim_start().starts_with('>')
            {
                index += 1;
            }
            let text = lines[start..index]
                .iter()
                .map(|line| {
                    line.trim_start().trim_start_matches('>').trim_start()
                })
                .collect::<Vec<_>>()
                .join("\n");
            nodes.push(Node::Quote(parse_inline(text.trim(), base)));
            continue;
        }

        if let Some(marker) = parse_list_marker(line) {
            let ordered = marker.ordered;
            let start = marker.start.unwrap_or(1);
            let base_indent = marker.indent;
            let mut items = vec![marker.text.trim().to_owned()];
            index += 1;

            while index < lines.len() {
                let next = lines[index];
                let next_trimmed = next.trim();
                if next_trimmed.is_empty() {
                    index += 1;
                    break;
                }
                if let Some(next_marker) = parse_list_marker(next) {
                    if next_marker.ordered == ordered
                        && next_marker.indent == base_indent
                    {
                        items.push(next_marker.text.trim().to_owned());
                        index += 1;
                        continue;
                    }
                    break;
                }
                // An indented line continues the item above it.
                let indent = next.len() - next.trim_start().len();
                if indent > base_indent {
                    if let Some(last) = items.last_mut() {
                        if !last.is_empty() {
                            last.push('\n');
                        }
                        last.push_str(next_trimmed);
                    }
                    index += 1;
                    continue;
                }
                break;
            }

            nodes.push(Node::List {
                ordered,
                start,
                items: items
                    .iter()
                    .map(|item| parse_inline(item, base))
                    .collect(),
            });
            continue;
        }

        // A paragraph runs to a blank line or the start of another block.
        let start = index;
        while index < lines.len() {
            let next = lines[index];
            let next_trimmed = next.trim();
            if next_trimmed.is_empty() {
                break;
            }
            if index != start
                && (parse_standalone_image_line(next_trimmed).is_some()
                    || parse_display_math_block(&lines[index..]).is_some()
                    || parse_fence_start(next_trimmed).is_some()
                    || parse_heading_line(next_trimmed).is_some()
                    || next_trimmed.starts_with('>')
                    || parse_list_marker(next).is_some()
                    || is_thematic_break(next_trimmed))
            {
                break;
            }
            index += 1;
        }
        let text = lines[start..index].join("\n");
        nodes.push(Node::Paragraph(parse_inline(text.trim(), base)));
    }

    Document { nodes }
}

fn image_or_link(base: Option<&Path>, alt: &str, dest: &str) -> Node {
    let alt = alt.trim();
    if let Some(path) = resolve_image_path(base, dest)
        && path.exists()
    {
        return Node::Image {
            path,
            caption: (!alt.is_empty()).then(|| alt.to_owned()),
        };
    }
    let url = normalize_link(base, dest);
    let text = if alt.is_empty() {
        url.clone().unwrap_or_else(|| dest.trim().to_owned())
    } else {
        alt.to_owned()
    };
    Node::Paragraph(vec![Span {
        text,
        url,
        ..Span::default()
    }])
}

struct Fence {
    delimiter: char,
    count: usize,
    language: Option<String>,
}

struct ListMarker<'a> {
    ordered: bool,
    start: Option<usize>,
    indent: usize,
    text: &'a str,
}

#[derive(Debug, Clone, Copy, Default)]
struct InlineStyle {
    strong: bool,
    emphasis: bool,
    strikethrough: bool,
}

fn parse_heading_line(line: &str) -> Option<(u8, &str)> {
    let hashes = line.bytes().take_while(|byte| *byte == b'#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let rest = line.get(hashes..)?.strip_prefix(' ')?;
    Some((hashes as u8, rest.trim()))
}

/// An absolute URL as it is; a relative one as a `file://` URL under
/// `base`; a fragment or, without a base, a relative link: none.
fn normalize_link(base: Option<&Path>, dest: &str) -> Option<String> {
    let dest = dest.trim();
    if dest.is_empty() || dest.starts_with('#') {
        return None;
    }
    if let Ok(url) = url::Url::parse(dest) {
        return Some(url.to_string());
    }
    url::Url::from_file_path(base?.join(dest))
        .ok()
        .map(|url| url.to_string())
}

fn resolve_image_path(base: Option<&Path>, dest: &str) -> Option<PathBuf> {
    let dest = dest.trim();
    if dest.is_empty() || dest.starts_with('#') {
        return None;
    }
    if let Ok(url) = url::Url::parse(dest) {
        return if url.scheme() == "file" {
            url.to_file_path().ok()
        } else {
            None
        };
    }
    Some(base?.join(dest))
}

fn parse_display_math_block(lines: &[&str]) -> Option<(Vec<String>, usize)> {
    let first = lines.first()?.trim();

    if first == "$$" || first == "\\[" {
        let closing = if first == "$$" { "$$" } else { "\\]" };
        let mut math = Vec::new();
        let mut consumed = 1;
        while consumed < lines.len() {
            if lines[consumed].trim() == closing {
                return Some((math, consumed + 1));
            }
            math.push(lines[consumed].to_owned());
            consumed += 1;
        }
        return Some((math, consumed));
    }

    for (open, close) in [("$$", "$$"), ("\\[", "\\]")] {
        if first.starts_with(open) && first.ends_with(close) && first.len() > 4
        {
            return Some((
                vec![first[2..first.len() - 2].trim().to_owned()],
                1,
            ));
        }
    }

    None
}

fn parse_fence_start(line: &str) -> Option<Fence> {
    let trimmed = line.trim_start();
    let delimiter = trimmed.chars().next()?;
    if delimiter != '`' && delimiter != '~' {
        return None;
    }
    let count = trimmed.chars().take_while(|c| *c == delimiter).count();
    if count < 3 {
        return None;
    }
    let language = trimmed[count..].trim();
    Some(Fence {
        delimiter,
        count,
        language: (!language.is_empty()).then(|| language.to_owned()),
    })
}

fn is_fence_end(line: &str, fence: &Fence) -> bool {
    line.trim_start()
        .chars()
        .take_while(|c| *c == fence.delimiter)
        .count()
        >= fence.count
}

fn parse_list_marker(line: &str) -> Option<ListMarker<'_>> {
    let indent = line.len() - line.trim_start().len();
    let trimmed = line.trim_start();

    for prefix in ["- ", "* ", "+ "] {
        if let Some(text) = trimmed.strip_prefix(prefix) {
            return Some(ListMarker {
                ordered: false,
                start: None,
                indent,
                text,
            });
        }
    }

    let digits = trimmed.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let number = trimmed.get(..digits)?.parse().ok()?;
    let rest = trimmed.get(digits..)?;
    for suffix in [". ", ") "] {
        if let Some(text) = rest.strip_prefix(suffix) {
            return Some(ListMarker {
                ordered: true,
                start: Some(number),
                indent,
                text,
            });
        }
    }
    None
}

fn parse_standalone_image_line(line: &str) -> Option<(String, String)> {
    let (alt, dest, consumed) = parse_bracket_token(line, true)?;
    (consumed == line.len()).then_some((alt, dest))
}

fn parse_inline(text: &str, base: Option<&Path>) -> Vec<Span> {
    let mut spans = Vec::new();
    let mut style = InlineStyle::default();
    let mut index = 0;

    while index < text.len() {
        let remaining = &text[index..];

        if let Some((alt, dest, consumed)) =
            parse_bracket_token(remaining, true)
        {
            let url = normalize_link(base, &dest);
            let label = if alt.trim().is_empty() {
                url.clone().unwrap_or(dest)
            } else {
                alt
            };
            push_span(&mut spans, styled(label, style, false, url));
            index += consumed;
            continue;
        }

        if let Some((label, dest, consumed)) =
            parse_bracket_token(remaining, false)
        {
            let url = normalize_link(base, &dest);
            push_span(&mut spans, styled(label, style, false, url));
            index += consumed;
            continue;
        }

        if let Some((escaped, consumed)) = parse_escaped_prefix(remaining) {
            push_span(&mut spans, styled(escaped, style, false, None));
            index += consumed;
            continue;
        }

        if remaining.starts_with("**") {
            style.strong = !style.strong;
            index += 2;
            continue;
        }

        if remaining.starts_with("~~") {
            style.strikethrough = !style.strikethrough;
            index += 2;
            continue;
        }

        if remaining.starts_with('*') {
            style.emphasis = !style.emphasis;
            index += 1;
            continue;
        }

        if let Some(code) = strip_delimited(remaining, "`", "`") {
            push_span(
                &mut spans,
                styled(code.to_owned(), InlineStyle::default(), true, None),
            );
            index += code.len() + 2;
            continue;
        }

        if let Some((url, consumed)) = parse_bare_url_prefix(remaining) {
            push_span(&mut spans, styled(url.clone(), style, false, Some(url)));
            index += consumed;
            continue;
        }

        let boundary =
            find_next_inline_boundary(remaining).unwrap_or(remaining.len());
        let plain = if boundary == 0 {
            let length = remaining.chars().next().map_or(1, char::len_utf8);
            &remaining[..length]
        } else {
            &remaining[..boundary]
        };
        push_span(&mut spans, styled(plain.to_owned(), style, false, None));
        index += plain.len();
    }

    spans
}

fn parse_bracket_token(
    input: &str,
    image: bool,
) -> Option<(String, String, usize)> {
    let prefix = if image { "![" } else { "[" };
    if !input.starts_with(prefix) {
        return None;
    }
    let label_start = prefix.len();
    let label_end = input[label_start..].find("](")? + label_start;
    let dest_start = label_end + 2;
    let dest_end = input[dest_start..].find(')')? + dest_start;
    Some((
        input[label_start..label_end].to_owned(),
        input[dest_start..dest_end].to_owned(),
        dest_end + 1,
    ))
}

fn strip_delimited<'a>(
    input: &'a str,
    prefix: &str,
    suffix: &str,
) -> Option<&'a str> {
    let rest = input.strip_prefix(prefix)?;
    let end = rest.find(suffix)?;
    Some(&rest[..end])
}

fn parse_bare_url_prefix(input: &str) -> Option<(String, usize)> {
    if !looks_like_url(input) {
        return None;
    }
    let end = input
        .find(|c: char| c.is_whitespace() || matches!(c, ')' | ']' | '>'))
        .unwrap_or(input.len());
    let candidate = &input[..end];
    let unescaped = unescape(candidate);
    let url = unescaped.trim_end_matches(['.', ',', ';', ':']);
    if url.is_empty() {
        return None;
    }
    Some((url.to_owned(), candidate.len()))
}

fn parse_escaped_prefix(input: &str) -> Option<(String, usize)> {
    let mut chars = input.strip_prefix('\\')?.chars();
    let escaped = chars.next()?;
    Some((escaped.to_string(), 1 + escaped.len_utf8()))
}

fn unescape(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\'
            && let Some(next) = chars.next()
        {
            result.push(next);
            continue;
        }
        result.push(c);
    }
    result
}

fn find_next_inline_boundary(input: &str) -> Option<usize> {
    input.char_indices().map(|(i, _)| i).find(|&index| {
        let remaining = &input[index..];
        remaining.starts_with('[')
            || remaining.starts_with("![")
            || remaining.starts_with('\\')
            || remaining.starts_with('*')
            || remaining.starts_with("~~")
            || remaining.starts_with('`')
            || looks_like_url(remaining)
    })
}

fn styled(
    text: String,
    style: InlineStyle,
    code: bool,
    url: Option<String>,
) -> Span {
    Span {
        text,
        strong: !code && style.strong,
        emphasis: !code && style.emphasis,
        code,
        strikethrough: !code && style.strikethrough,
        url,
    }
}

fn is_thematic_break(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.len() >= 3
        && ["---", "***", "___"]
            .iter()
            .any(|pattern| trimmed.chars().all(|c| pattern.contains(c)))
}

/// Add a span, joining it to the previous one when they look the same.
fn push_span(target: &mut Vec<Span>, span: Span) {
    if span.text.is_empty() {
        return;
    }
    if let Some(last) = target.last_mut()
        && last.strong == span.strong
        && last.emphasis == span.emphasis
        && last.code == span.code
        && last.strikethrough == span.strikethrough
        && last.url == span.url
    {
        last.text.push_str(&span.text);
    } else {
        target.push(span);
    }
}

fn looks_like_url(value: &str) -> bool {
    value.starts_with("http://") || value.starts_with("https://")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(spans: &[Span]) -> String {
        spans.iter().map(|span| span.text.as_str()).collect()
    }

    #[test]
    fn keeps_a_documents_structure() {
        let doc = parse(
            "# Title\n\nA [link](https://example.com) with `code`, **bold** and *it*.\n\n\
             - First\n- Second\n  goes on\n\n3. three\n4. four\n\n> quoted\n\n---\n\n\
             $$x^2 + y^2$$\n\n```rs\nfn main() {}\n```\n",
            None,
        );

        assert!(matches!(&doc.nodes[0], Node::Heading { level: 1, .. }));
        let Node::Paragraph(spans) = &doc.nodes[1] else {
            panic!("{:?}", doc.nodes[1]);
        };
        assert_eq!(text(spans), "A link with code, bold and it.");
        assert!(
            spans
                .iter()
                .any(|s| s.url.as_deref() == Some("https://example.com/"))
        );
        assert!(spans.iter().any(|s| s.code && s.text == "code"));
        assert!(spans.iter().any(|s| s.strong && s.text == "bold"));
        assert!(spans.iter().any(|s| s.emphasis && s.text == "it"));
        let Node::List {
            items,
            ordered: false,
            ..
        } = &doc.nodes[2]
        else {
            panic!("{:?}", doc.nodes[2]);
        };
        assert_eq!(text(&items[1]), "Second\ngoes on");
        assert!(matches!(
            &doc.nodes[3],
            Node::List { ordered: true, start: 3, items } if items.len() == 2
        ));
        assert!(matches!(&doc.nodes[4], Node::Quote(_)));
        assert_eq!(doc.nodes[5], Node::Rule);
        assert_eq!(
            doc.nodes[6],
            Node::CodeBlock {
                language: Some("math".into()),
                lines: vec!["x^2 + y^2".into()],
            }
        );
        assert_eq!(
            doc.nodes[7],
            Node::CodeBlock {
                language: Some("rs".into()),
                lines: vec!["fn main() {}".into()],
            }
        );
        assert_eq!(doc.nodes.len(), 8);
    }

    #[test]
    fn prices_stay_text_and_escapes_stay_literal() {
        let doc = parse(
            "Smart retries cost ~$40/mo, or $10 once.\n\n\
             Lilei Zheng\\* , Ying Zhang\n\n\
             https://www.ema.gov.sg/System\\_Planning.aspx\n",
            None,
        );

        let Node::Paragraph(spans) = &doc.nodes[0] else {
            panic!()
        };
        assert_eq!(text(spans), "Smart retries cost ~$40/mo, or $10 once.");
        assert!(spans.iter().all(|span| !span.code));
        let Node::Paragraph(spans) = &doc.nodes[1] else {
            panic!()
        };
        assert_eq!(text(spans), "Lilei Zheng* , Ying Zhang");
        let Node::Paragraph(spans) = &doc.nodes[2] else {
            panic!()
        };
        assert_eq!(text(spans), "https://www.ema.gov.sg/System_Planning.aspx");
        assert_eq!(
            spans[0].url.as_deref(),
            Some("https://www.ema.gov.sg/System_Planning.aspx")
        );
    }

    #[test]
    fn relative_links_and_images_need_a_base() {
        let dir = std::env::temp_dir()
            .join(format!("quarterdeck-markdown-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("figure.png"), b"png").unwrap();
        let markdown =
            "See [appendix](appendix.pdf).\n\n![Figure](figure.png)\n";

        let with_base = parse(markdown, Some(&dir));
        let Node::Paragraph(spans) = &with_base.nodes[0] else {
            panic!()
        };
        assert!(spans.iter().any(|s| {
            s.url.as_deref().is_some_and(|u| u.starts_with("file://"))
        }));
        assert_eq!(
            with_base.nodes[1],
            Node::Image {
                path: dir.join("figure.png"),
                caption: Some("Figure".into()),
            }
        );

        // A message body has no folder: no file links, no local images.
        let without = parse(markdown, None);
        let Node::Paragraph(spans) = &without.nodes[0] else {
            panic!()
        };
        assert!(spans.iter().all(|s| s.url.is_none()));
        assert!(matches!(&without.nodes[1], Node::Paragraph(_)));

        let _ = std::fs::remove_dir_all(dir);
    }
}
