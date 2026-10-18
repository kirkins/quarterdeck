/**
 * Turns a report into the document shown in the reader's frame (srcdoc).
 *
 * The frame is the security boundary. The portal acts as the captain, so a
 * report must never run in the portal's origin. The frame is a sandboxed
 * iframe without allow-same-origin, and this document sets a CSP that lets
 * nothing load from the network and only the annotator script (carrying a
 * fresh nonce) run. Markdown is rendered here, with raw HTML escaped, and then
 * takes the same path as HTML. See docs/DECISIONS.md, section 14.
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
		}
	}
});

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
 * A report's own `<meta http-equiv="refresh">` would navigate the frame to
 * whatever it names. CSP does not stop that, so it is removed.
 */
function stripRefresh(html: string): string {
	return html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, '');
}

/** Read-only styles for the frame, in the portal's palette, light and dark. */
const CSS = `
:root { color-scheme: light dark; }
:root[data-theme='light'] { color-scheme: light; }
:root[data-theme='dark'] { color-scheme: dark; }
[hidden] { display: none !important; }
html { background: light-dark(#fffdf8, #112033); }
body {
	margin: 0;
	padding: 1rem;
	color: light-dark(#0f1d2e, #e9eef5);
	font: 1rem/1.6 system-ui, -apple-system, 'Segoe UI', sans-serif;
	overflow-wrap: anywhere;
	-webkit-text-size-adjust: 100%;
}
.report { max-width: 46rem; margin: 0 auto; }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.6em 0 0.5em; }
h1 { font-size: 1.6rem; }
h2 { font-size: 1.3rem; }
h3 { font-size: 1.12rem; }
p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
ul, ol { padding-left: 1.4rem; }
a { color: light-dark(#15534d, #9be3d8); }
blockquote {
	margin-left: 0;
	padding: 0.1rem 0 0.1rem 0.9rem;
	border-left: 3px solid light-dark(#d8b971, #6e5726);
	color: light-dark(#3a495d, #bccad9);
}
code, pre {
	font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
	font-size: 0.9em;
}
code {
	padding: 0.05em 0.3em;
	border-radius: 4px;
	background: light-dark(#f3efe5, #0d1a2a);
}
pre {
	padding: 0.75rem;
	overflow-x: auto;
	border-radius: 8px;
	background: light-dark(#f3efe5, #0d1a2a);
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
	border: 1px solid light-dark(#e3dccb, #1f324b);
	text-align: left;
	vertical-align: top;
}
img { max-width: 100%; height: auto; }
hr { border: 0; border-top: 1px solid light-dark(#e3dccb, #1f324b); margin: 1.5rem 0; }

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
	background: light-dark(#13294b, #e9eef5);
	color: light-dark(#f5f2ea, #0b1623);
	box-shadow: 0 6px 20px rgb(0 0 0 / 0.25);
	cursor: pointer;
}
.qd-pop:disabled { opacity: 0.5; cursor: default; }
.qd-pill { transform: translate(-100%, -100%); }
`;

/** The srcdoc for one report, with a fresh nonce for its annotator. */
export function renderFrame(format: ReportFormat, content: string): string {
	const nonce = randomBytes(16).toString('base64');
	const body = stripRefresh(
		format === 'markdown' ? (markdown.parse(content, { async: false }) as string) : content
	);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${frameCsp(nonce)}">
<style>${CSS}</style>
<script nonce="${nonce}">${annotator}</script>
</head>
<body>
<div class="report">${body}</div>
</body>
</html>`;
}
