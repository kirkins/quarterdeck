import { describe, expect, it } from 'vitest';
import {
	REPORT_LIMITS,
	checkAnnotation,
	checkAnnotations,
	commentRights,
	findQuote,
	parseFromFrame,
	reportOf
} from './report.ts';

const inline = { title: 'Review', format: 'markdown', content: '# Review\n\nText.' };

describe('reportOf', () => {
	it('is null when the payload has no report', () => {
		expect(reportOf({})).toBeNull();
		expect(reportOf(null)).toBeNull();
	});

	it('reads an inline report', () => {
		expect(reportOf({ report: inline })).toEqual({
			ok: true,
			value: { kind: 'inline', title: 'Review', format: 'markdown', content: '# Review\n\nText.' }
		});
	});

	it('reads a report held by id', () => {
		expect(reportOf({ report: { title: 'Audit', format: 'html', report_id: 'r-7' } })).toEqual({
			ok: true,
			value: { kind: 'by_id', title: 'Audit', format: 'html', report_id: 'r-7' }
		});
	});

	it('refuses a missing title, an unknown format and no content', () => {
		expect(reportOf({ report: { ...inline, title: '  ' } })).toMatchObject({ ok: false });
		expect(reportOf({ report: { ...inline, format: 'pdf' } })).toMatchObject({ ok: false });
		expect(reportOf({ report: { title: 'x', format: 'html' } })).toMatchObject({ ok: false });
	});

	it('refuses inline content over 256 KiB, counted in bytes', () => {
		const content = 'é'.repeat(REPORT_LIMITS.bytes / 2 + 1);
		expect(reportOf({ report: { ...inline, content } })).toMatchObject({ ok: false });
		const fits = 'a'.repeat(REPORT_LIMITS.bytes);
		expect(reportOf({ report: { ...inline, content: fits } })).toMatchObject({ ok: true });
	});
});

describe('checkAnnotation and checkAnnotations', () => {
	const quoted = { quote: 'the cold tier', prefix: 'The ', suffix: ' moved' };

	it('accepts a passage anchor and trims the comment', () => {
		expect(checkAnnotation({ anchor: quoted, comment: '  keep it  ' })).toEqual({
			ok: true,
			value: { anchor: quoted, comment: 'keep it' }
		});
	});

	it('accepts a block anchor with its selector and quote', () => {
		const anchor = { selector: '2/0/1', quote: 'Run the check' };
		expect(checkAnnotation({ anchor, comment: 'why?' })).toMatchObject({ ok: true });
	});

	it('refuses an empty or over-long comment and an over-long quote', () => {
		expect(checkAnnotation({ anchor: quoted, comment: '   ' })).toMatchObject({ ok: false });
		const long = 'x'.repeat(REPORT_LIMITS.comment + 1);
		expect(checkAnnotation({ anchor: quoted, comment: long })).toMatchObject({ ok: false });
		const quote = 'x'.repeat(REPORT_LIMITS.quote + 1);
		expect(checkAnnotation({ anchor: { quote }, comment: 'ok' })).toMatchObject({ ok: false });
	});

	it('refuses context over 2000 characters and an anchor without a quote', () => {
		const prefix = 'p'.repeat(REPORT_LIMITS.quote + 1);
		expect(checkAnnotation({ anchor: { quote: 'a', prefix }, comment: 'ok' })).toMatchObject({
			ok: false
		});
		expect(checkAnnotation({ anchor: { prefix: 'x' }, comment: 'ok' })).toMatchObject({
			ok: false
		});
	});

	it('drops fields it does not know rather than sending them', () => {
		const checked = checkAnnotation({
			anchor: { quote: 'a', evil: true },
			comment: 'ok',
			extra: 1
		});
		expect(checked).toEqual({ ok: true, value: { anchor: { quote: 'a' }, comment: 'ok' } });
	});

	it('caps one reply at 100 comments', () => {
		const one = { anchor: { quote: 'a' }, comment: 'ok' };
		expect(checkAnnotations(Array(100).fill(one))).toMatchObject({ ok: true });
		expect(checkAnnotations(Array(101).fill(one))).toMatchObject({ ok: false });
		expect(checkAnnotations([one, { anchor: {}, comment: 'x' }])).toMatchObject({
			ok: false,
			error: expect.stringContaining('annotations[1]')
		});
	});
});

describe('findQuote', () => {
	const text = 'Keep the old bucket. Retire the old bucket later. Nothing else.';

	it('finds a quote and its span', () => {
		expect(findQuote(text, { quote: 'Nothing else' })).toEqual({
			start: text.indexOf('Nothing'),
			end: text.indexOf('Nothing') + 'Nothing else'.length
		});
	});

	it('prefers the occurrence whose context still matches', () => {
		const at = findQuote(text, { quote: 'old bucket', prefix: 'Retire the ', suffix: ' later' });
		expect(at).toEqual({
			start: text.indexOf('old bucket', 30),
			end: text.indexOf('old bucket', 30) + 10
		});
	});

	it('still finds a quote whose context has changed', () => {
		expect(findQuote(text, { quote: 'Keep the', prefix: 'gone ', suffix: 'x' })).toEqual({
			start: 0,
			end: 8
		});
	});

	it('returns null when the text is gone, rather than guessing', () => {
		expect(findQuote(text, { quote: 'Deleted passage' })).toBeNull();
		expect(findQuote(text, { quote: '' })).toBeNull();
	});
});

describe('parseFromFrame', () => {
	const TOKEN = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
	/** A message as this render's annotator sends it: with the token. */
	const signed = (message: Record<string, unknown>) => ({ ...message, token: TOKEN });
	const parse = (data: unknown) => parseFromFrame(data, TOKEN);

	it('accepts the three messages the frame sends', () => {
		expect(parse(signed({ type: 'text', text: 'Hello' }))).toEqual({
			type: 'text',
			text: 'Hello'
		});
		expect(
			parse(signed({ type: 'select', anchor: { quote: 'Hi', prefix: 'a', suffix: 'b' } }))
		).toEqual({ type: 'select', anchor: { quote: 'Hi', prefix: 'a', suffix: 'b' } });
		expect(parse(signed({ type: 'block', anchor: { selector: '1/0', quote: 'Hi' } }))).toEqual({
			type: 'block',
			anchor: { selector: '1/0', quote: 'Hi' }
		});
	});

	it('drops a message without this render’s token, as from a document the frame was sent to', () => {
		const text = { type: 'text', text: 'Hello' };
		const block = { type: 'block', anchor: { selector: '1/0', quote: 'Hi' } };
		expect(parse(text)).toBeNull();
		expect(parse(block)).toBeNull();
		expect(parse({ ...text, token: 'f'.repeat(32) })).toBeNull();
		expect(parse({ ...text, token: TOKEN.toUpperCase() })).toBeNull();
		expect(parse({ ...text, token: [TOKEN] })).toBeNull();
		// No token to expect (no render yet) accepts nothing, not everything.
		expect(parseFromFrame({ ...text, token: '' }, '')).toBeNull();
		expect(parseFromFrame(text, '')).toBeNull();
	});

	it('refuses a selection that carries a selector, and a block without one', () => {
		expect(parse(signed({ type: 'select', anchor: { selector: '1', quote: 'x' } }))).toBeNull();
		expect(parse(signed({ type: 'block', anchor: { quote: 'x' } }))).toBeNull();
	});

	it('refuses unknown types, non-objects and oversize quotes', () => {
		expect(parse(signed({ type: 'navigate', href: 'https://example.invalid' }))).toBeNull();
		expect(parse('text')).toBeNull();
		expect(parse(null)).toBeNull();
		expect(
			parse(signed({ type: 'select', anchor: { quote: 'x'.repeat(REPORT_LIMITS.quote + 1) } }))
		).toBeNull();
	});
});

describe('anchor limits as Privateer checks them', () => {
	it('allows a selector and a prefix up to 2000 characters, and refuses more', () => {
		const max = 'x'.repeat(REPORT_LIMITS.quote);
		const over = max + 'x';
		expect(
			checkAnnotation({ anchor: { selector: '0/1', quote: max }, comment: 'ok' })
		).toMatchObject({ ok: true });
		expect(
			checkAnnotation({ anchor: { selector: '0/1', quote: 'a' }, comment: 'ok' })
		).toMatchObject({ ok: true });
		expect(
			checkAnnotation({ anchor: { quote: 'a', prefix: max, suffix: max }, comment: 'ok' })
		).toMatchObject({ ok: true });
		expect(
			checkAnnotation({ anchor: { selector: over, quote: 'a' }, comment: 'ok' })
		).toMatchObject({ ok: false });
		expect(checkAnnotation({ anchor: { quote: 'a', suffix: over }, comment: 'ok' })).toMatchObject({
			ok: false
		});
	});

	it('leaves an empty prefix or suffix off the wire rather than sending ""', () => {
		const checked = checkAnnotation({
			anchor: { quote: 'a', prefix: '', suffix: '' },
			comment: 'ok'
		});
		expect(checked).toEqual({ ok: true, value: { anchor: { quote: 'a' }, comment: 'ok' } });
	});
});

describe('commentRights', () => {
	it('takes comments on a request, and sends them', () => {
		expect(commentRights('request', 'request')).toEqual({ comment: true, send: true });
	});

	it('takes comments on a notice, and sends them as its annotations', () => {
		expect(commentRights('notice', 'notice')).toEqual({ comment: true, send: true });
	});

	it('reads a report on its own, and takes no comments on it', () => {
		expect(commentRights('report', 'notice')).toEqual({ comment: false, send: false });
	});

	it('takes no comments on a decision or an approval', () => {
		expect(commentRights('decision', 'decision')).toEqual({ comment: false, send: false });
		expect(commentRights('request', 'approval')).toEqual({ comment: false, send: false });
	});
});
