import { describe, expect, it } from 'vitest';
import { frameCsp, renderFrame } from './render.ts';

/** The nonce the frame's CSP and its annotator script both carry. */
function nonceOf(srcdoc: string): string {
	const match = srcdoc.match(/<script nonce="([^"]+)">/);
	if (!match) throw new Error('no annotator script in the frame');
	return match[1];
}

describe('renderFrame', () => {
	it('shows raw HTML in Markdown as text, never as markup', () => {
		const srcdoc = renderFrame(
			'markdown',
			'Hello <script>alert(1)</script> <img src="https://x.invalid/a.png">'
		);
		const body = srcdoc.slice(srcdoc.indexOf('<div class="report">'));
		expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(body).not.toContain('<script>alert(1)');
		expect(body).not.toContain('<img src="https://x.invalid/a.png">');
	});

	it('renders Markdown structure: headings, lists, tables and code', () => {
		const srcdoc = renderFrame(
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
		const srcdoc = renderFrame('html', content);
		expect(srcdoc).toContain('<h1>Audit</h1>');
		expect(srcdoc).not.toMatch(/http-equiv\s*=\s*["']?refresh/i);
	});

	it('gives every frame its own nonce, and the one script carries it', () => {
		const a = renderFrame('html', '<p>a</p>');
		const b = renderFrame('html', '<p>b</p>');
		expect(nonceOf(a)).not.toBe(nonceOf(b));
		expect(a).toContain(`'nonce-${nonceOf(a)}'`);
		expect(a.match(/<script\b/g)).toHaveLength(1);
	});

	it('sets a CSP that allows only the nonce’d script, styles, and data: images', () => {
		const srcdoc = renderFrame('html', '<p>x</p>');
		const csp = frameCsp(nonceOf(srcdoc));
		expect(csp).toBe(
			`default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonceOf(srcdoc)}'; base-uri 'none'; form-action 'none'`
		);
		expect(srcdoc).toContain(`<meta http-equiv="Content-Security-Policy" content="${csp}">`);
	});

	it('puts the annotator before the report, so the report cannot stop it', () => {
		const srcdoc = renderFrame('html', '<!-- unclosed comment');
		expect(srcdoc.indexOf('<script nonce=')).toBeLessThan(srcdoc.indexOf('<!-- unclosed'));
	});
});
