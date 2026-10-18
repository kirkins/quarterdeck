/**
 * Turns a report into the document shown in the reader's frame (srcdoc).
 *
 * The frame is the security boundary. The portal acts as the captain, so a
 * report must never run in the portal's origin. The frame is a sandboxed
 * iframe without allow-same-origin, and this document sets a CSP that lets
 * nothing load from the network and only the annotator script (carrying a
 * fresh nonce) run. Markdown is rendered here, with raw HTML escaped and only
 * http(s), mailto and #fragment links kept, and then takes the same path as
 * HTML. Every render also has a token that only the annotator knows; the
 * portal drops any message without it. See docs/DECISIONS.md, section 15.
 */
import { randomBytes } from 'node:crypto';
import { Marked } from 'marked';
// Kept as text, not a module, so the app's TypeScript and lint do not treat it as app code.
import annotator from './annotator.txt?raw';
import type { ReportFormat } from '#lib/report.ts';

const markdown = new Marked({
	gfm: true,
	renderer: {
		// Raw HTML in a Markdown report is shown as text, never as markup.
		html({ text }) {
			return escapeHtml(text);
		},
		// A link to anywhere but the web, mail or this page is shown as its text alone.
		link({ href, tokens }) {
			return safeHref(href) ? false : this.parser.parseInline(tokens);
		},
		// An image is kept only from the web (which the frame's CSP then refuses): no data: or script URLs.
		image({ href, text }) {
			return /^https?:/i.test(urlOf(href)) ? false : escapeHtml(text);
		}
	}
});

/** A URL as the browser reads it: without the spaces and controls around it, or the tabs and newlines in it. */
function urlOf(href: string): string {
	// eslint-disable-next-line no-control-regex
	return href.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '').replace(/[\t\n\r]/g, '');
}

/**
 * Whether a Markdown link may keep its href: http(s), mailto or a #fragment
 * only. A literal scheme prefix cannot be turned into another by entities, so
 * this is an allow list on the text as written, not a deny list.
 */
export function safeHref(href: string): boolean {
	return /^(?:https?:|mailto:|#)/i.test(urlOf(href));
}

export function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

/**
 * The CSP for the frame. Only the nonce'd annotator runs; no network loads
 * (images are data: URIs only, as a report's own pictures cannot be fetched);
 * no forms, no base URL change.
 */
export function frameCsp(nonce: string): string {
	return [
		"default-src 'none'",
		"style-src 'unsafe-inline'",
		'img-src data:',
		`script-src 'nonce-${nonce}'`,
		"base-uri 'none'",
		"form-action 'none'"
	].join('; ');
}

/**
 * Elements whose `<` is escaped to text: each could navigate the frame, or
 * hide a link from the annotator's guard. A nested frame (an `iframe srcdoc`
 * passes the frame's CSP) runs no annotator, so its `target=_parent` links
 * would; a closed shadow root (`<template shadowrootmode>`) keeps its links
 * out of the click's path; object and embed are refused by CSP already.
 */
const ESCAPED = [
	'meta',
	'iframe',
	'frame',
	'frameset',
	'object',
	'embed',
	'portal',
	'fencedframe',
	'template'
];
const ESCAPED_TAG = new RegExp(`<(?=(?:${ESCAPED.join('|')})[\\s/>])`, 'gi');

/**
 * Make a report's HTML unable to leave the frame. Every `<meta>` element is
 * removed, whatever it says: a `<meta http-equiv="refresh">` navigates the
 * frame and CSP does not stop it, and its attributes may be written with
 * character references (`re&#102;resh`), so matching them is not enough. A
 * tag name cannot be written with references, and the parser starts an
 * element only at `<name` followed by whitespace, `/` or `>`, in any case.
 *
 * A removal can join the text either side into a new tag (`<me<meta>ta`), so
 * then every `<` that starts a meta or one of the other ESCAPED elements is
 * escaped to `&lt;`. That pass changes only those `<`, so it cannot make
 * another. Both passes are linear, so a crafted report cannot make this slow.
 */
export function defuse(html: string): string {
	return html.replace(/<meta(?=[\s/>])[^>]*>?/gi, '').replace(ESCAPED_TAG, '&lt;');
}

/** Read-only styles for the frame, in the portal's palette, light and dark. */
const CSS = `
:root { color-scheme: light dark; }
:root[data-theme='light'] { color-scheme: light; }
:root[data-theme='dark'] { color-scheme: dark; }
[hidden] { display: none !important; }
html { background: light-dark(#fffdf9, #0f1c2b); }
body {
	margin: 0;
	padding: 1.25rem 1.25rem 2.5rem;
	color: light-dark(#0e1b2c, #e8edf3);
	font: 1rem/1.65 system-ui, -apple-system, 'Segoe UI', sans-serif;
	overflow-wrap: anywhere;
	-webkit-text-size-adjust: 100%;
}
.report { max-width: 46rem; margin: 0 auto; }
h1, h2, h3, h4 {
	line-height: 1.22;
	margin: 1.6em 0 0.5em;
	font-family: 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif;
	font-weight: 600;
	letter-spacing: -0.01em;
}
h1 { font-size: 1.75rem; margin-top: 0.4em; }
h2 { font-size: 1.3rem; }
h3 { font-size: 1.12rem; }
p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
ul, ol { padding-left: 1.4rem; }
a { color: light-dark(#114f48, #9ee4d9); text-underline-offset: 0.18em; }
blockquote {
	margin-left: 0;
	padding: 0.1rem 0 0.1rem 0.9rem;
	border-left: 2px solid light-dark(#dcbd77, #6b5527);
	color: light-dark(#3b4a5e, #b8c5d4);
}
code, pre {
	font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
	font-size: 0.9em;
}
code {
	padding: 0.05em 0.3em;
	border-radius: 4px;
	background: light-dark(#efebe1, #060e17);
}
pre {
	padding: 0.75rem;
	overflow-x: auto;
	border-radius: 10px;
	background: light-dark(#efebe1, #060e17);
}
pre code { padding: 0; background: none; }
table {
	display: block;
	max-width: 100%;
	overflow-x: auto;
	border-collapse: collapse;
}
th, td {
	padding: 0.35rem 0.6rem;
	border: 1px solid light-dark(rgb(15 29 46 / 0.12), rgb(196 214 235 / 0.12));
	text-align: left;
	vertical-align: top;
}
th { background: light-dark(#f7f4ed, #0c1724); font-weight: 600; }
img { max-width: 100%; height: auto; }
hr { border: 0; border-top: 1px solid light-dark(rgb(15 29 46 / 0.12), rgb(196 214 235 / 0.12)); margin: 1.5rem 0; }

::highlight(qd-comment) { background-color: rgb(114 207 193 / 0.38); color: inherit; }
::highlight(qd-focus) { background-color: rgb(228 192 114 / 0.6); color: inherit; }
.qd-marked { background-color: rgb(114 207 193 / 0.22); border-radius: 4px; }

.qd-pop, .qd-pill {
	position: absolute;
	z-index: 10;
	transform: translate(-50%, -115%);
	font: 600 0.9rem/1 system-ui, sans-serif;
	padding: 0.6rem 0.9rem;
	min-height: 44px;
	border: 0;
	border-radius: 999px;
	background: light-dark(#12284a, #e8edf3);
	color: light-dark(#f4f1ea, #08121d);
	box-shadow: 0 6px 20px rgb(0 0 0 / 0.25);
	cursor: pointer;
}
.qd-pop:disabled { opacity: 0.5; cursor: default; }
.qd-pill { transform: translate(-100%, -100%); }
`;

/** One rendered report: the frame's document, and the token its annotator signs messages with. */
export interface RenderedFrame {
	srcdoc: string;
	token: string;
}

/**
 * The srcdoc for one report, with a fresh nonce for its annotator and a fresh
 * token. The token is written into the annotator's script text (never an
 * attribute, which CSS could match), and the portal never sends it into the
 * frame, so a document the frame is navigated to cannot learn it.
 */
export function renderFrame(format: ReportFormat, content: string): RenderedFrame {
	const nonce = randomBytes(16).toString('base64');
	const token = randomBytes(16).toString('hex');
	const body = defuse(
		format === 'markdown' ? (markdown.parse(content, { async: false }) as string) : content
	);
	const script = annotator.replaceAll('__QD_TOKEN__', token);
	const srcdoc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${frameCsp(nonce)}">
<style>${CSS}</style>
<script nonce="${nonce}">${script}</script>
</head>
<body>
<div class="report">${body}</div>
</body>
</html>`;
	return { srcdoc, token };
}
