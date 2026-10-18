/**
 * Reports: a ship's long document, which the captain reads and annotates.
 * This module is the one place their shape, limits and checks live. It is
 * shared by server and browser code, so no Node APIs here.
 *
 * Agreed with Privateer (see docs/DECISIONS.md, section 14):
 *
 *   payload.report = { title, format: "markdown" | "html", content }       inline
 *   payload.report = { title, format, report_id }                         by reference
 *
 * Annotations go back as captain.reply {id, body, payload: {annotations}}.
 * An anchor is { quote, prefix?, suffix? } for a passage the captain selected,
 * or { selector, quote } for a block they tapped.
 */

export const REPORT_LIMITS = {
	title: 200,
	/** Inline or fetched report content, in bytes. */
	bytes: 256 * 1024,
	annotations: 100,
	comment: 4096,
	/** The text an anchor quotes, in characters. */
	quote: 2000,
	/** Text kept either side of a quote, to find it again if it moves. */
	context: 32,
	selector: 200,
	note: 2000,
	id: 64
} as const;

export type ReportFormat = 'markdown' | 'html';
export const REPORT_FORMATS: readonly ReportFormat[] = ['markdown', 'html'];

/** A report as the payload names it: inline, or by id to fetch with report.get. */
export type ReportRef =
	| { kind: 'inline'; title: string; format: ReportFormat; content: string }
	| { kind: 'by_id'; title: string; format: ReportFormat; report_id: string };

export type Anchor =
	{ quote: string; prefix?: string; suffix?: string } | { selector: string; quote: string };

export interface Annotation {
	anchor: Anchor;
	comment: string;
}

/** A half-open span of the report's flattened text, by character index. */
export interface Span {
	start: number;
	end: number;
}

type Rec = Record<string, unknown>;
type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

function rec(value: unknown): Rec | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Rec)
		: null;
}

/** Characters, not UTF-16 units, so limits match what a captain counts. */
function length(value: string): number {
	return [...value].length;
}

export function byteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}

/**
 * Read `payload.report`. Null when the item has no report at all; an error
 * when it has one that breaks the agreed shape or limits.
 */
export function reportOf(payload: unknown): Checked<ReportRef> | null {
	const raw = rec(rec(payload)?.report);
	if (!raw) return null;
	const title = typeof raw.title === 'string' ? raw.title.trim() : '';
	if (title === '' || length(title) > REPORT_LIMITS.title) {
		return { ok: false, error: `report.title must be 1 to ${REPORT_LIMITS.title} characters` };
	}
	const format = raw.format;
	if (!REPORT_FORMATS.includes(format as ReportFormat)) {
		return { ok: false, error: 'report.format must be "markdown" or "html"' };
	}
	if (typeof raw.report_id === 'string' && raw.report_id !== '') {
		if (length(raw.report_id) > REPORT_LIMITS.id) {
			return {
				ok: false,
				error: `report.report_id must be at most ${REPORT_LIMITS.id} characters`
			};
		}
		return {
			ok: true,
			value: { kind: 'by_id', title, format: format as ReportFormat, report_id: raw.report_id }
		};
	}
	if (typeof raw.content !== 'string') {
		return { ok: false, error: 'report needs inline content or a report_id' };
	}
	if (byteLength(raw.content) > REPORT_LIMITS.bytes) {
		return { ok: false, error: 'This report is larger than the portal will show inline.' };
	}
	return {
		ok: true,
		value: { kind: 'inline', title, format: format as ReportFormat, content: raw.content }
	};
}

/** Check report content fetched by id, against the same size limit as inline content. */
export function checkContent(content: unknown): Checked<string> {
	if (typeof content !== 'string') return { ok: false, error: 'report content must be a string' };
	if (byteLength(content) > REPORT_LIMITS.bytes) {
		return { ok: false, error: 'This report is larger than the portal will show.' };
	}
	return { ok: true, value: content };
}

function boundedText(value: unknown, max: number, path: string, min = 1): Checked<string> {
	if (typeof value !== 'string') return { ok: false, error: `${path} must be a string` };
	const n = length(value);
	if (n < min) return { ok: false, error: `${path} must not be empty` };
	if (n > max) return { ok: false, error: `${path} must be at most ${max} characters` };
	return { ok: true, value };
}

/** Check one anchor, whichever of its two shapes it takes. */
export function checkAnchor(input: unknown): Checked<Anchor> {
	const raw = rec(input);
	if (!raw) return { ok: false, error: 'anchor must be an object' };

	const quote = boundedText(raw.quote, REPORT_LIMITS.quote, 'anchor.quote');
	if (!quote.ok) return quote;

	if (raw.selector !== undefined) {
		const selector = boundedText(raw.selector, REPORT_LIMITS.selector, 'anchor.selector');
		if (!selector.ok) return selector;
		return { ok: true, value: { selector: selector.value, quote: quote.value } };
	}

	const anchor: { quote: string; prefix?: string; suffix?: string } = { quote: quote.value };
	for (const key of ['prefix', 'suffix'] as const) {
		if (raw[key] === undefined) continue;
		const context = boundedText(raw[key], REPORT_LIMITS.context, `anchor.${key}`, 0);
		if (!context.ok) return context;
		anchor[key] = context.value;
	}
	return { ok: true, value: anchor };
}

/** Check one comment: an anchor and the captain's words about it. */
export function checkAnnotation(input: unknown): Checked<Annotation> {
	const raw = rec(input);
	if (!raw) return { ok: false, error: 'annotation must be an object' };
	const anchor = checkAnchor(raw.anchor);
	if (!anchor.ok) return anchor;
	const comment = boundedText(
		typeof raw.comment === 'string' ? raw.comment.trim() : raw.comment,
		REPORT_LIMITS.comment,
		'comment'
	);
	if (!comment.ok) return comment;
	return { ok: true, value: { anchor: anchor.value, comment: comment.value } };
}

/** Check the whole list sent as one reply: at most 100 entries, each one valid. */
export function checkAnnotations(input: unknown): Checked<Annotation[]> {
	if (!Array.isArray(input)) return { ok: false, error: 'annotations must be a list' };
	if (input.length > REPORT_LIMITS.annotations) {
		return { ok: false, error: `Send at most ${REPORT_LIMITS.annotations} comments at once.` };
	}
	const out: Annotation[] = [];
	for (const [i, entry] of input.entries()) {
		const checked = checkAnnotation(entry);
		if (!checked.ok) return { ok: false, error: `annotations[${i}]: ${checked.error}` };
		out.push(checked.value);
	}
	return { ok: true, value: out };
}

/**
 * Find where an anchor's quote sits in the report's text. Where the quote
 * occurs more than once, the occurrence whose surrounding text still matches
 * wins. Null means the text is gone, and the comment is kept but shown as
 * unanchored rather than dropped.
 */
export function findQuote(
	text: string,
	anchor: { quote: string; prefix?: string; suffix?: string }
): Span | null {
	const { quote, prefix = '', suffix = '' } = anchor;
	if (quote === '') return null;
	let best: Span | null = null;
	let bestScore = -1;
	for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) {
		const end = at + quote.length;
		const score =
			(prefix === '' || text.slice(0, at).endsWith(prefix) ? 1 : 0) +
			(suffix === '' || text.slice(end).startsWith(suffix) ? 1 : 0);
		if (score > bestScore) {
			best = { start: at, end };
			bestScore = score;
		}
		if (score === 2) break;
	}
	return best;
}

/** What the annotator frame may tell the portal. */
export type FromFrame =
	| { type: 'text'; text: string }
	| { type: 'select'; anchor: { quote: string; prefix: string; suffix: string } }
	| { type: 'block'; anchor: { selector: string; quote: string } };

/**
 * Validate a message from the annotator frame. Everything else is dropped:
 * the portal acts as the captain, so nothing from the frame is trusted until
 * it has been checked here.
 */
export function parseFromFrame(data: unknown): FromFrame | null {
	const msg = rec(data);
	if (!msg) return null;
	if (msg.type === 'text') {
		if (typeof msg.text !== 'string' || byteLength(msg.text) > REPORT_LIMITS.bytes * 2) return null;
		return { type: 'text', text: msg.text };
	}
	if (msg.type === 'select') {
		const anchor = checkAnchor(msg.anchor);
		if (!anchor.ok || 'selector' in anchor.value) return null;
		return {
			type: 'select',
			anchor: {
				quote: anchor.value.quote,
				prefix: anchor.value.prefix ?? '',
				suffix: anchor.value.suffix ?? ''
			}
		};
	}
	if (msg.type === 'block') {
		const anchor = checkAnchor(msg.anchor);
		if (!anchor.ok || !('selector' in anchor.value)) return null;
		return {
			type: 'block',
			anchor: { selector: anchor.value.selector, quote: anchor.value.quote }
		};
	}
	return null;
}

/** What the portal tells the annotator frame. Its own check is in docs/DECISIONS.md. */
export type ToFrame =
	| { type: 'marks'; marks: ({ id: string } & Span)[] }
	| { type: 'focus'; id: string }
	| { type: 'theme'; theme: 'light' | 'dark' | 'system' };
