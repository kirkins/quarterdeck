/**
 * The decision schema agreed with Privateer, a validator for it, and the
 * normalisation that turns captain mail into the cards the UI renders.
 *
 * This module is shared by server and browser code, so it must stay free of
 * Node APIs.
 */

/** Limits from the agreed schema. */
export const LIMITS = {
	question: 200,
	why: 500,
	blocked: 10,
	blockedItem: 200,
	optionsMin: 2,
	optionsMax: 8,
	optionId: 32,
	optionLabel: 80,
	whatHappens: 400,
	cost: 80,
	group: 64
} as const;

/** Identifiers (option ids, group keys): letters, digits, `-`, `_`, `.`, not starting with punctuation. */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export interface DecisionOption {
	id: string;
	label: string;
	what_happens: string;
	cost?: string;
	recommended?: boolean;
}

/** `payload.decision` on a mail of kind "decision". */
export interface Decision {
	question: string;
	why?: string;
	blocked: string[];
	options: DecisionOption[];
	/** A hint that the ship especially invites a written answer. The captain may always write their own. */
	free_text_ok: boolean;
	group?: string;
}

/**
 * A mail item as returned by captain.waiting / runtime.needs. Only the fields
 * Quarterdeck reads are typed; anything else is passed through untouched.
 */
export interface MailItem {
	id: string;
	from: string;
	to: string;
	kind: string;
	body?: string | null;
	payload?: Record<string, unknown> | null;
	task_id?: string | null;
	correlation?: string | null;
	request_kind?: string | null;
	deadline_ms?: number | null;
	created_ms?: number;
	asked_ms?: number;
	age_ms?: number;
	hands_on?: unknown;
	urgency?: string;
	[key: string]: unknown;
}

export type ValidationResult = { ok: true; decision: Decision } | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkString(
	errors: string[],
	value: unknown,
	path: string,
	max: number,
	{ min = 1 }: { min?: number } = {}
): value is string {
	if (typeof value !== 'string') {
		errors.push(`${path} must be a string`);
		return false;
	}
	const length = [...value].length;
	if (length < min) errors.push(`${path} must not be empty`);
	if (length > max) errors.push(`${path} must be at most ${max} characters`);
	return length >= min && length <= max;
}

function checkIdentifier(errors: string[], value: unknown, path: string, max: number): void {
	if (!checkString(errors, value, path, max)) return;
	if (!IDENTIFIER.test(value as string)) {
		errors.push(`${path} must be an identifier (letters, digits, "-", "_", ".")`);
	}
}

/**
 * Validate `payload.decision`. Returns the decision with defaults applied
 * (`blocked: []`, `free_text_ok: false`) or every problem found.
 */
export function validateDecision(input: unknown): ValidationResult {
	const errors: string[] = [];
	if (!isRecord(input)) return { ok: false, errors: ['decision must be an object'] };

	checkString(errors, input.question, 'question', LIMITS.question);
	if (input.why !== undefined) checkString(errors, input.why, 'why', LIMITS.why, { min: 0 });

	if (input.blocked !== undefined) {
		if (!Array.isArray(input.blocked)) {
			errors.push('blocked must be a list');
		} else {
			if (input.blocked.length > LIMITS.blocked) {
				errors.push(`blocked must have at most ${LIMITS.blocked} entries`);
			}
			input.blocked.forEach((item, i) =>
				checkString(errors, item, `blocked[${i}]`, LIMITS.blockedItem)
			);
		}
	}

	if (!Array.isArray(input.options)) {
		errors.push('options must be a list');
	} else {
		const { options } = input;
		if (options.length < LIMITS.optionsMin || options.length > LIMITS.optionsMax) {
			errors.push(`options must have ${LIMITS.optionsMin} to ${LIMITS.optionsMax} entries`);
		}
		const seen = new Set<string>();
		let recommended = 0;
		options.forEach((option, i) => {
			const path = `options[${i}]`;
			if (!isRecord(option)) {
				errors.push(`${path} must be an object`);
				return;
			}
			checkIdentifier(errors, option.id, `${path}.id`, LIMITS.optionId);
			if (typeof option.id === 'string') {
				if (seen.has(option.id)) errors.push(`${path}.id "${option.id}" is not unique`);
				seen.add(option.id);
			}
			checkString(errors, option.label, `${path}.label`, LIMITS.optionLabel);
			checkString(errors, option.what_happens, `${path}.what_happens`, LIMITS.whatHappens);
			if (option.cost !== undefined) {
				checkString(errors, option.cost, `${path}.cost`, LIMITS.cost, { min: 0 });
			}
			if (option.recommended !== undefined && typeof option.recommended !== 'boolean') {
				errors.push(`${path}.recommended must be true or false`);
			}
			if (option.recommended === true) recommended += 1;
		});
		if (recommended > 1) errors.push('at most one option may be recommended');
	}

	if (input.free_text_ok !== undefined && typeof input.free_text_ok !== 'boolean') {
		errors.push('free_text_ok must be true or false');
	}
	if (input.group !== undefined) checkIdentifier(errors, input.group, 'group', LIMITS.group);

	if (errors.length > 0) return { ok: false, errors };

	const options = (input.options as Record<string, unknown>[]).map((o) => {
		const option: DecisionOption = {
			id: o.id as string,
			label: o.label as string,
			what_happens: o.what_happens as string
		};
		if (typeof o.cost === 'string' && o.cost !== '') option.cost = o.cost;
		if (o.recommended === true) option.recommended = true;
		return option;
	});
	const decision: Decision = {
		question: input.question as string,
		blocked: (input.blocked as string[] | undefined) ?? [],
		options,
		free_text_ok: input.free_text_ok === true
	};
	if (typeof input.why === 'string' && input.why !== '') decision.why = input.why;
	if (typeof input.group === 'string') decision.group = input.group;
	return { ok: true, decision };
}

/* ------------------------------------------------------------------------ */
/* Cards                                                                    */
/* ------------------------------------------------------------------------ */

/** How a question was understood. */
export type QuestionKind =
	/** A valid `payload.decision`. */
	| 'decision'
	/** Older mail: `body` plus `payload.choices` (plain strings). */
	| 'legacy'
	/** A decision payload that failed validation, shown from its body so it is not lost. */
	| 'invalid';

export interface CardOption {
	id: string;
	label: string;
	what_happens?: string;
	cost?: string;
	recommended?: boolean;
}

export interface Answered {
	option_id?: string;
	label?: string;
	text?: string;
	at_ms: number;
	/** False when the answer was only logged (fixture mode or sending disabled). */
	sent: boolean;
}

/** One thing the captain can answer: one mail item. */
export interface Question {
	/** The asking mail's id; the reply's correlation. */
	id: string;
	from: string;
	task_id: string | null;
	kind: QuestionKind;
	question: string;
	why: string | null;
	blocked: string[];
	options: CardOption[];
	/** Hint only: the ship especially invites a written answer. Every question accepts one. */
	free_text_ok: boolean;
	hands_on: string | null;
	deadline_ms: number | null;
	asked_ms: number;
	/** Validation problems, for kind "invalid". */
	problems: string[];
	answered: Answered | null;
}

/** One card: a single question, or several from one sender sharing a group. */
export interface Card {
	key: string;
	from: string;
	group: string | null;
	questions: Question[];
	/** Earliest deadline of any unanswered question (or of any question, once all are answered). */
	deadline_ms: number | null;
	/** When the oldest question was asked. */
	asked_ms: number;
}

/** True when a mail item belongs on the Decisions page. */
export function isDecisionMail(item: MailItem): boolean {
	const payload = isRecord(item.payload) ? item.payload : {};
	return item.kind === 'decision' || 'decision' in payload || Array.isArray(payload.choices);
}

function handsOnText(value: unknown): string | null {
	if (typeof value === 'string') return value.trim() || null;
	if (value === true) return 'This needs you in person.';
	if (isRecord(value)) {
		for (const key of ['summary', 'text', 'body', 'what', 'description']) {
			const text = value[key];
			if (typeof text === 'string' && text.trim()) return text.trim();
		}
	}
	return null;
}

function legacyChoices(payload: Record<string, unknown>): CardOption[] {
	if (!Array.isArray(payload.choices)) return [];
	return payload.choices
		.filter((c): c is string => typeof c === 'string' && c.trim() !== '')
		.map((label, i) => ({ id: `choice-${i + 1}`, label }));
}

/**
 * Split a plain message body into a headline and supporting text. Prefer the
 * last sentence that asks something ("…today, or wait?"); otherwise the first
 * sentence. Short bodies are the headline as they stand.
 */
export function splitBody(body: string | null | undefined): {
	question: string;
	why: string | null;
} {
	const text = (body ?? '').replace(/\s+/g, ' ').trim();
	if (text === '') return { question: 'A ship is waiting on your answer.', why: null };
	if (text.length <= 120) return { question: text, why: null };
	const sentences = text.split(/(?<=[.!?])\s+/);
	let index = sentences.findLastIndex((sentence) => sentence.endsWith('?'));
	if (index === -1) index = 0;
	let question = sentences[index];
	const rest = sentences.filter((_, i) => i !== index).join(' ');
	if ([...question].length > LIMITS.question) {
		question = [...question].slice(0, LIMITS.question - 1).join('') + '…';
		return { question, why: text };
	}
	return { question, why: rest || null };
}

/** Turn one mail item into a question, never throwing on malformed input. */
export function toQuestion(item: MailItem, now: number): Question {
	const payload = isRecord(item.payload) ? item.payload : {};
	const asked_ms =
		item.asked_ms ?? item.created_ms ?? (typeof item.age_ms === 'number' ? now - item.age_ms : now);
	const base = {
		id: item.id,
		from: item.from,
		task_id: item.task_id ?? null,
		hands_on: handsOnText(item.hands_on),
		deadline_ms: typeof item.deadline_ms === 'number' ? item.deadline_ms : null,
		asked_ms,
		answered: null
	};

	if ('decision' in payload) {
		const result = validateDecision(payload.decision);
		if (result.ok) {
			const { decision } = result;
			return {
				...base,
				kind: 'decision',
				question: decision.question,
				why: decision.why ?? null,
				blocked: decision.blocked,
				options: decision.options,
				free_text_ok: decision.free_text_ok,
				problems: []
			};
		}
		return {
			...base,
			kind: 'invalid',
			...splitBody(item.body),
			blocked: [],
			options: legacyChoices(payload),
			free_text_ok: true,
			problems: result.errors
		};
	}

	const options = legacyChoices(payload);
	return {
		...base,
		kind: 'legacy',
		...splitBody(item.body),
		blocked: [],
		options,
		// With fewer than two choices the ship is clearly inviting a written answer.
		free_text_ok: options.length < 2,
		problems: []
	};
}

function groupOf(item: MailItem): string | null {
	const payload = isRecord(item.payload) ? item.payload : {};
	const decision = isRecord(payload.decision) ? payload.decision : null;
	const group = decision?.group;
	return typeof group === 'string' && IDENTIFIER.test(group) && group.length <= LIMITS.group
		? group
		: null;
}

/**
 * Compare deadlines: earliest first, no deadline last; then oldest ask first.
 */
function compareUrgency(
	a: { deadline_ms: number | null; asked_ms: number },
	b: { deadline_ms: number | null; asked_ms: number }
): number {
	if (a.deadline_ms !== b.deadline_ms) {
		if (a.deadline_ms === null) return 1;
		if (b.deadline_ms === null) return -1;
		return a.deadline_ms - b.deadline_ms;
	}
	return a.asked_ms - b.asked_ms;
}

/**
 * Build cards from mail: keep decision mail, de-duplicate by id, group by
 * sender + group, and sort by deadline then age. Answered questions stay on
 * their card (marked) so the captain sees what they just did.
 */
export function buildCards(
	items: MailItem[],
	now: number,
	answered: ReadonlyMap<string, Answered> = new Map()
): Card[] {
	const seen = new Set<string>();
	const cards = new Map<string, Card>();

	for (const item of items) {
		if (!item || typeof item.id !== 'string' || seen.has(item.id) || !isDecisionMail(item)) {
			continue;
		}
		seen.add(item.id);
		const question = toQuestion(item, now);
		question.answered = answered.get(item.id) ?? null;
		const group = groupOf(item);
		const key = group ? `${item.from}\u0000${group}` : `id\u0000${item.id}`;
		const card = cards.get(key);
		if (card) {
			card.questions.push(question);
		} else {
			cards.set(key, {
				key: group ? `${item.from}/${group}` : item.id,
				from: item.from,
				group,
				questions: [question],
				deadline_ms: null,
				asked_ms: question.asked_ms
			});
		}
	}

	for (const card of cards.values()) {
		card.questions.sort(compareUrgency);
		const open = card.questions.filter((q) => !q.answered);
		const relevant = open.length > 0 ? open : card.questions;
		const deadlines = relevant.flatMap((q) => (q.deadline_ms === null ? [] : [q.deadline_ms]));
		card.deadline_ms = deadlines.length > 0 ? Math.min(...deadlines) : null;
		card.asked_ms = Math.min(...card.questions.map((q) => q.asked_ms));
	}

	return [...cards.values()].sort((a, b) => {
		// Fully answered cards sink to the bottom.
		const aDone = a.questions.every((q) => q.answered);
		const bDone = b.questions.every((q) => q.answered);
		if (aDone !== bDone) return aDone ? 1 : -1;
		return compareUrgency(a, b);
	});
}
