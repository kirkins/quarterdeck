import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { ReportFormat } from '#lib/report.ts';
import { ANNOTATOR_HASH, defuse, frameCsp, renderFrame, safeHref } from './render.ts';

/** The frame's document alone. */
function srcdocOf(format: ReportFormat, content: string): string {
	return renderFrame(format, content).srcdoc;
}

/** The report's part of the frame's document, after the portal's own head. */
function bodyOf(srcdoc: string): string {
	return srcdoc.slice(srcdoc.indexOf('<div class="report">'));
}

/** Whether an HTML parser would start a meta element anywhere in the text. */
const META_TAG = /<meta[\s/>]/i;

/** The nonce the frame's CSP and its annotator script both carry. */
function nonceOf(srcdoc: string): string {
	const match = srcdoc.match(/<script nonce="([^"]+)">/);
	if (!match) throw new Error('no annotator script in the frame');
	return match[1];
}

describe('renderFrame', () => {
	it('shows raw HTML in Markdown as text, never as markup', () => {
		const srcdoc = srcdocOf(
			'markdown',
			'Hello <script>alert(1)</script> <img src="https://x.invalid/a.png">'
		);
		const body = srcdoc.slice(srcdoc.indexOf('<div class="report">'));
		expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(body).not.toContain('<script>alert(1)');
		expect(body).not.toContain('<img src="https://x.invalid/a.png">');
	});

	it('renders Markdown structure: headings, lists, tables and code', () => {
		const srcdoc = srcdocOf(
			'markdown',
			'# Title\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```sh\necho hi\n```'
		);
		expect(srcdoc).toContain('<h1>Title</h1>');
		expect(srcdoc).toContain('<li>one</li>');
		expect(srcdoc).toContain('<table>');
		expect(srcdoc).toContain('echo hi');
	});

	it('leaves an HTML report as written, but strips a meta refresh that would navigate the frame', () => {
		const content =
			'<h1>Audit</h1><meta http-equiv="refresh" content="0; url=https://x.invalid/"><script>window.ran = true</script>';
		const srcdoc = srcdocOf('html', content);
		expect(srcdoc).toContain('<h1>Audit</h1>');
		expect(srcdoc).not.toMatch(/http-equiv\s*=\s*["']?refresh/i);
		expect(bodyOf(srcdoc)).not.toMatch(META_TAG);
	});

	it.each([
		['entity-encoded', '<meta http-equiv="re&#102;resh" content="0;url=https://x.invalid/">'],
		['hex-encoded', '<meta http-equiv="&#x72;&#X65;fresh" content="0;url=https://x.invalid/">'],
		['named reference', '<meta http-equiv="refresh" content="0;url&equals;https://x.invalid/">'],
		['mixed case', '<MeTa HTTP-EQUIV=ReFrEsH CONTENT="0;url=https://x.invalid/">'],
		['whitespace', '<meta\n\thttp-equiv = "refresh"\fcontent=\'0;url=https://x.invalid/\'>'],
		['slash', '<meta/http-equiv=refresh/content=0;url=https://x.invalid/>'],
		['a > in a value', '<meta content="0;url=https://x.invalid/?a>b" http-equiv=refresh>'],
		['unclosed', '<p>End</p><meta http-equiv=refresh content=0;url=https://x.invalid/'],
		[
			'in the body of an SVG',
			'<svg><meta http-equiv=refresh content=0;url=https://x.invalid/></svg>'
		],
		['made by a removal', '<me<meta>ta http-equiv=refresh content=0;url=https://x.invalid/>'],
		['made by nested removals', '<me<me<meta>ta>ta http-equiv=refresh content=0>']
	])('leaves no meta element from a %s refresh', (_, refresh) => {
		const body = bodyOf(srcdocOf('html', `<p>Before</p>${refresh}<p>After</p>`));
		expect(body).not.toMatch(META_TAG);
		expect(body).toContain('<p>Before</p>');
	});

	it('removes every meta element, not only refresh, and leaves look-alikes alone', () => {
		expect(defuse('<meta charset="utf-8"><meta name="x" content="y"><p>Hi</p>')).toBe('<p>Hi</p>');
		expect(defuse('<metadata>x</metadata><p>metal</p>')).toBe('<metadata>x</metadata><p>metal</p>');
	});

	it.each([
		['a nested frame', '<iframe srcdoc="&lt;a href=x target=_parent&gt;go&lt;/a&gt;"></iframe>'],
		['a nested frame, in capitals', '<IFRAME\nsrcdoc="x"></IFRAME>'],
		['a frameset', '<frameset><frame src="x"></frameset>'],
		['an object and an embed', '<object data="x"></object><embed src="x">'],
		[
			'a closed shadow root',
			'<div><template shadowrootmode="closed"><a href="x">go</a></template></div>'
		],
		['a portal and a fenced frame', '<portal src="x"></portal><fencedframe></fencedframe>']
	])('escapes %s to text, as it could take a link out of the guard’s reach', (_, html) => {
		const out = defuse(html);
		expect(out).not.toMatch(
			/<(?:i?frame|frameset|object|embed|portal|fencedframe|template)[\s/>]/i
		);
		expect(out).toContain('&lt;');
	});

	it('strips a crafted report in linear time', () => {
		const crafted =
			'<me'.repeat(80_000) + '<meta>' + 'ta>'.repeat(80_000) + '<iframe '.repeat(30_000);
		const started = performance.now();
		const out = defuse(crafted);
		expect(out).not.toMatch(META_TAG);
		expect(out).not.toMatch(/<iframe/i);
		expect(performance.now() - started).toBeLessThan(1000);
	});

	it('keeps only http(s), mailto and #fragment links in Markdown', () => {
		const md = [
			'[a](javascript:alert(1))',
			'[b](JaVaScRiPt:alert(1))',
			'[c](&#106;avascript:alert(1))',
			'[d](vbscript:msgbox)',
			'[e](data:text/html,<script>alert(1)</script>)',
			'[f](/relative/path)',
			'<javascript:alert(1)>',
			'[g][ref]',
			'',
			'[ref]: javascript:alert(1)',
			'',
			'[web](https://example.invalid/a) [mail](mailto:ops) [here](#open-questions)'
		].join('\n');
		const body = bodyOf(srcdocOf('markdown', md));
		const hrefs = [...body.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
		expect(hrefs).toEqual(['https://example.invalid/a', 'mailto:ops', '#open-questions']);
		// The neutralised links keep their text, as text: nothing else is a link or a source.
		expect(body).toContain('<p>a\nb\nc\nd\ne\nf\njavascript:alert(1)\ng</p>');
		expect(body.match(/<a\b/g)).toHaveLength(3);
		expect(body).not.toMatch(/\ssrc\s*=/i);
	});

	it('keeps a Markdown image only from the web, and shows the alt text otherwise', () => {
		const body = bodyOf(
			srcdocOf(
				'markdown',
				'![chart](https://example.invalid/c.png) ![pixel](data:image/png;base64,AAAA) ![x](javascript:alert(1))'
			)
		);
		expect(body).toContain('src="https://example.invalid/c.png"');
		expect(body).not.toMatch(/data:|javascript:/i);
		expect(body).toContain('pixel');
	});

	it('reads a URL as the browser does when deciding if it is safe', () => {
		expect(safeHref(' https://example.invalid')).toBe(true);
		expect(safeHref('\u0000javascript:alert(1)')).toBe(false);
		expect(safeHref('java\tscript:alert(1)')).toBe(false);
		expect(safeHref(' #top')).toBe(true);
		expect(safeHref('//example.invalid')).toBe(false);
	});

	it('gives every frame its own nonce, and the one script carries it', () => {
		const a = srcdocOf('html', '<p>a</p>');
		const b = srcdocOf('html', '<p>b</p>');
		expect(nonceOf(a)).not.toBe(nonceOf(b));
		expect(a).toContain(`'nonce-${nonceOf(a)}'`);
		// The other script element is the token's JSON block, which never runs.
		expect(a.match(/<script\b/g)).toHaveLength(2);
		expect(a.match(/<script nonce=/g)).toHaveLength(1);
		expect(a.match(/<script type="application\/json" id="qd-token">/g)).toHaveLength(1);
	});

	it('sets a CSP that allows only the nonce’d script, styles, and data: images', () => {
		const srcdoc = srcdocOf('html', '<p>x</p>');
		const csp = frameCsp(nonceOf(srcdoc));
		expect(csp).toBe(
			`default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonceOf(srcdoc)}'; base-uri 'none'; form-action 'none'`
		);
		expect(srcdoc).toContain(`<meta http-equiv="Content-Security-Policy" content="${csp}">`);
	});

	it('puts the annotator before the report, so the report cannot stop it', () => {
		const srcdoc = srcdocOf('html', '<!-- unclosed comment');
		expect(srcdoc.indexOf('<script nonce=')).toBeLessThan(srcdoc.indexOf('<!-- unclosed'));
	});

	it('gives every render its own token, written only into the block the annotator reads', () => {
		const a = renderFrame('html', '<p>a</p>');
		const b = renderFrame('html', '<p>a</p>');
		expect(a.token).toMatch(/^[0-9a-f]{32}$/);
		expect(a.token).not.toBe(b.token);
		expect(tokenOf(a.srcdoc)).toBe(a.token);
		expect(a.srcdoc.split(a.token)).toHaveLength(2);
		expect(a.srcdoc).not.toContain(b.token);
		// The block comes before the annotator, which reads it while the head is parsed.
		expect(a.srcdoc.indexOf('id="qd-token"')).toBeLessThan(a.srcdoc.indexOf('<script nonce='));
	});

	it('writes the same annotator into every frame, matching the hash the portal’s CSP allows', () => {
		const a = scriptOf(renderFrame('html', '<p>a</p>').srcdoc);
		const b = scriptOf(renderFrame('markdown', '# b').srcdoc);
		expect(a).toBe(b);
		const hash = `sha256-${createHash('sha256').update(a).digest('base64')}`;
		expect(hash).toBe(ANNOTATOR_HASH);
		// vite.config.ts hashes the file itself; the ?raw import must be byte for byte the same.
		const file = readFileSync(new URL('./annotator.txt', import.meta.url), 'utf8');
		expect(a).toBe(file);
	});
});

/** The render's token, from the JSON block before the annotator. */
function tokenOf(srcdoc: string): string {
	const match = srcdoc.match(/<script type="application\/json" id="qd-token">([^<]*)<\/script>/);
	if (!match) throw new Error('no token block in the frame');
	return JSON.parse(match[1]);
}

/** The annotator's source, as written into the frame. */
function scriptOf(srcdoc: string): string {
	const match = srcdoc.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
	if (!match) throw new Error('no annotator script in the frame');
	return match[1];
}

/**
 * Run the annotator against a stand-in window, just enough to see what it
 * sends and which clicks it stops. The real DOM is covered by e2e/report.e2e.ts.
 */
function runAnnotator(srcdoc: string) {
	class Element {
		constructor(
			public localName: string,
			private attrs: Record<string, string> = {},
			private ns: Record<string, string> = {}
		) {}
		hasAttribute(name: string) {
			return name in this.attrs;
		}
		hasAttributeNS(ns: string, name: string) {
			return this.ns[name] === ns;
		}
		closest() {
			return null;
		}
	}
	const listeners: Record<string, ((event: unknown) => void)[]> = {};
	const on = (type: string, fn: (event: unknown) => void) => {
		(listeners[type] ??= []).push(fn);
	};
	const sent: unknown[] = [];
	const window = {
		addEventListener: on,
		parent: { postMessage: (message: unknown) => sent.push(message) },
		getSelection: () => ({ isCollapsed: true })
	};
	const token = tokenOf(srcdoc);
	const document = {
		getElementById: (id: string) =>
			id === 'qd-token' ? { textContent: JSON.stringify(token), remove: () => {} } : null,
		readyState: 'complete',
		body: new Element('body'),
		addEventListener: on,
		createTreeWalker: () => ({ nextNode: () => null })
	};
	runInNewContext(scriptOf(srcdoc), { window, document, Element, NodeFilter: { SHOW_TEXT: 4 } });

	/** Click through a path of elements, innermost first; true if the default was prevented. */
	function click(type: string, path: InstanceType<typeof Element>[]): boolean {
		let prevented = false;
		const event = {
			type,
			target: path[0],
			composedPath: () => path,
			preventDefault: () => {
				prevented = true;
			}
		};
		for (const fn of listeners[type] ?? []) fn(event);
		return prevented;
	}
	return { sent, click, Element };
}

describe('the annotator', () => {
	const XLINK = 'http://www.w3.org/1999/xlink';

	it('signs what it sends with its render’s token', () => {
		const { srcdoc, token } = renderFrame('html', '<p>a</p>');
		const { sent } = runAnnotator(srcdoc);
		expect(sent).toEqual([{ type: 'text', text: '', token }]);
	});

	it('stops a click on any link: HTML, SVG (href or xlink:href), image map, MathML', () => {
		const { click, Element } = runAnnotator(renderFrame('html', '').srcdoc);
		const body = new Element('body');
		const text = new Element('tspan');
		const links = [
			new Element('a', { href: 'https://x.invalid' }),
			new Element('a', {}, { href: XLINK }),
			new Element('a', { href: 'https://x.invalid' }),
			new Element('area', { href: 'https://x.invalid' }),
			new Element('mtext', { href: 'https://x.invalid' })
		];
		for (const link of links) {
			expect(click('click', [text, link, new Element('svg'), body])).toBe(true);
			expect(click('auxclick', [link, body])).toBe(true);
		}
		expect(click('click', [new Element('p'), body])).toBe(false);
	});

	it('cancels form submits and drops', () => {
		const { click, Element } = runAnnotator(renderFrame('html', '').srcdoc);
		expect(click('submit', [new Element('form')])).toBe(true);
		expect(click('drop', [new Element('p')])).toBe(true);
	});
});
