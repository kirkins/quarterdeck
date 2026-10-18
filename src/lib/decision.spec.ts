import { describe, expect, it } from 'vitest';
import {
	askKey,
	buildCards,
	isDecisionMail,
	splitBody,
	toQuestion,
	validateDecision,
	type MailItem
} from './decision.ts';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

function decision(overrides: Record<string, unknown> = {}) {
	return {
		question: 'Ship it?',
		options: [
			{ id: 'yes', label: 'Yes', what_happens: 'It ships.' },
			{ id: 'no', label: 'No', what_happens: 'It waits.' }
		],
		...overrides
	};
}

function mail(overrides: Partial<MailItem> = {}): MailItem {
	return {
		id: 'm1',
		from: 'chandlery',
		to: 'captain',
		kind: 'decision',
		body: 'Ship it?',
		payload: { decision: decision() },
		created_ms: NOW - HOUR,
		deadline_ms: null,
		...overrides
	};
}

describe('validateDecision', () => {
	it('accepts a minimal decision and fills defaults', () => {
		const result = validateDecision(decision());
		expect(result).toEqual({
			ok: true,
			decision: {
				question: 'Ship it?',
				blocked: [],
				free_text_ok: false,
				options: [
					{ id: 'yes', label: 'Yes', what_happens: 'It ships.' },
					{ id: 'no', label: 'No', what_happens: 'It waits.' }
				]
			}
		});
	});

	it('keeps every optional field', () => {
		const result = validateDecision(
			decision({
				why: 'Because.',
				blocked: ['billing', 'task-7'],
				free_text_ok: true,
				group: 'launch-lists',
				options: [
					{ id: 'a', label: 'A', what_happens: 'x', cost: '~$4', recommended: true },
					{ id: 'b', label: 'B', what_happens: 'y', recommended: false }
				]
			})
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.decision.why).toBe('Because.');
		expect(result.decision.blocked).toEqual(['billing', 'task-7']);
		expect(result.decision.free_text_ok).toBe(true);
		expect(result.decision.group).toBe('launch-lists');
		expect(result.decision.options[0]).toMatchObject({ cost: '~$4', recommended: true });
		expect(result.decision.options[1].recommended).toBeUndefined();
	});

	it.each([
		['not an object', null, 'decision must be an object'],
		['a missing question', decision({ question: undefined }), 'question must be a string'],
		['an empty question', decision({ question: '' }), 'question must not be empty'],
		['a long question', decision({ question: 'q'.repeat(201) }), 'question must be at most 200'],
		['a long why', decision({ why: 'w'.repeat(501) }), 'why must be at most 500'],
		['too many blocked', decision({ blocked: Array(11).fill('x') }), 'at most 10 entries'],
		[
			'a long blocked entry',
			decision({ blocked: ['b'.repeat(201)] }),
			'blocked[0] must be at most'
		],
		[
			'one option',
			decision({ options: [{ id: 'a', label: 'A', what_happens: 'x' }] }),
			'options must have 2 to 8'
		],
		[
			'nine options',
			decision({
				options: Array.from({ length: 9 }, (_, i) => ({
					id: `o${i}`,
					label: 'L',
					what_happens: 'x'
				}))
			}),
			'options must have 2 to 8'
		],
		[
			'duplicate option ids',
			decision({
				options: [
					{ id: 'a', label: 'A', what_happens: 'x' },
					{ id: 'a', label: 'B', what_happens: 'y' }
				]
			}),
			'is not unique'
		],
		[
			'a bad option id',
			decision({
				options: [
					{ id: 'has space', label: 'A', what_happens: 'x' },
					{ id: 'b', label: 'B', what_happens: 'y' }
				]
			}),
			'must be an identifier'
		],
		[
			'a long option id',
			decision({
				options: [
					{ id: 'a'.repeat(33), label: 'A', what_happens: 'x' },
					{ id: 'b', label: 'B', what_happens: 'y' }
				]
			}),
			'options[0].id must be at most 32'
		],
		[
			'a long label',
			decision({
				options: [
					{ id: 'a', label: 'L'.repeat(81), what_happens: 'x' },
					{ id: 'b', label: 'B', what_happens: 'y' }
				]
			}),
			'options[0].label must be at most 80'
		],
		[
			'a missing what_happens',
			decision({
				options: [
					{ id: 'a', label: 'A' },
					{ id: 'b', label: 'B', what_happens: 'y' }
				]
			}),
			'options[0].what_happens must be a string'
		],
		[
			'a long cost',
			decision({
				options: [
					{ id: 'a', label: 'A', what_happens: 'x', cost: 'c'.repeat(81) },
					{ id: 'b', label: 'B', what_happens: 'y' }
				]
			}),
			'options[0].cost must be at most 80'
		],
		[
			'two recommendations',
			decision({
				options: [
					{ id: 'a', label: 'A', what_happens: 'x', recommended: true },
					{ id: 'b', label: 'B', what_happens: 'y', recommended: true }
				]
			}),
			'at most one option may be recommended'
		],
		['a non-boolean free_text_ok', decision({ free_text_ok: 'yes' }), 'free_text_ok must be'],
		['a bad group', decision({ group: 'not ok!' }), 'group must be an identifier'],
		['a long group', decision({ group: 'g'.repeat(65) }), 'group must be at most 64']
	])('rejects %s', (_name, input, message) => {
		const result = validateDecision(input);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.join('\n')).toContain(message);
	});

	it('counts characters, not UTF-16 units', () => {
		expect(validateDecision(decision({ question: '⚓'.repeat(200) })).ok).toBe(true);
	});
});

describe('isDecisionMail', () => {
	it('takes decisions and older choices-only asks, not plain requests', () => {
		expect(isDecisionMail(mail())).toBe(true);
		expect(isDecisionMail(mail({ kind: 'request', payload: { choices: ['a', 'b'] } }))).toBe(true);
		expect(isDecisionMail(mail({ kind: 'request', payload: {} }))).toBe(false);
		expect(isDecisionMail(mail({ kind: 'request', payload: null }))).toBe(false);
	});
});

describe('toQuestion', () => {
	it('normalises a valid decision', () => {
		const q = toQuestion(mail({ task_id: 't1', deadline_ms: NOW + HOUR }), NOW);
		expect(q).toMatchObject({
			id: 'm1',
			from: 'chandlery',
			task_id: 't1',
			kind: 'decision',
			question: 'Ship it?',
			deadline_ms: NOW + HOUR,
			asked_ms: NOW - HOUR,
			free_text_ok: false,
			answered: null
		});
	});

	it('renders older choices-only mail with its body as the question', () => {
		const q = toQuestion(
			mail({ kind: 'request', body: 'Ship 2.3 today?', payload: { choices: ['Ship', 'Wait'] } }),
			NOW
		);
		expect(q.kind).toBe('legacy');
		expect(q.question).toBe('Ship 2.3 today?');
		expect(q.options).toEqual([
			{ id: 'choice-1', label: 'Ship' },
			{ id: 'choice-2', label: 'Wait' }
		]);
		expect(q.free_text_ok).toBe(false);
	});

	it('lets the captain write when an older ask has no real choices', () => {
		const q = toQuestion(mail({ kind: 'request', payload: { choices: ['Only one'] } }), NOW);
		expect(q.free_text_ok).toBe(true);
	});

	it('keeps an invalid decision visible, with its problems', () => {
		const q = toQuestion(
			mail({ body: 'Pick one please', payload: { decision: { question: '' } } }),
			NOW
		);
		expect(q.kind).toBe('invalid');
		expect(q.question).toBe('Pick one please');
		expect(q.problems.length).toBeGreaterThan(0);
		expect(q.free_text_ok).toBe(true);
	});

	it('reads hands_on from needs_hands asks', () => {
		expect(toQuestion(mail({ hands_on: 'Plug in the key.' }), NOW).hands_on).toBe(
			'Plug in the key.'
		);
		expect(toQuestion(mail({ hands_on: { summary: 'Sign in.' } }), NOW).hands_on).toBe('Sign in.');
		expect(toQuestion(mail({ hands_on: null }), NOW).hands_on).toBeNull();
	});

	it('falls back to age_ms when there is no timestamp', () => {
		const q = toQuestion(mail({ created_ms: undefined, age_ms: 5 * HOUR }), NOW);
		expect(q.asked_ms).toBe(NOW - 5 * HOUR);
	});
});

describe('splitBody', () => {
	it('keeps short bodies whole', () => {
		expect(splitBody('Ship it today?')).toEqual({ question: 'Ship it today?', why: null });
	});

	it('leads with the sentence that asks', () => {
		const body =
			'Release 2.3 is built and passed QA on both platforms. Ship it to the stores today, or wait about two days for the crash fix?';
		expect(splitBody(body)).toEqual({
			question: 'Ship it to the stores today, or wait about two days for the crash fix?',
			why: 'Release 2.3 is built and passed QA on both platforms.'
		});
	});

	it('has something to say for an empty body', () => {
		expect(splitBody('').question).toMatch(/waiting/);
	});
});

describe('buildCards', () => {
	it('sorts by deadline (none last), then oldest first', () => {
		const cards = buildCards(
			[
				mail({ id: 'none-new', created_ms: NOW - HOUR }),
				mail({ id: 'later', deadline_ms: NOW + 5 * HOUR }),
				mail({ id: 'none-old', created_ms: NOW - 9 * HOUR }),
				mail({ id: 'overdue', deadline_ms: NOW - HOUR }),
				mail({ id: 'soon-old', deadline_ms: NOW + HOUR, created_ms: NOW - 3 * HOUR }),
				mail({ id: 'soon-new', deadline_ms: NOW + HOUR, created_ms: NOW - 2 * HOUR })
			],
			NOW
		);
		expect(cards.map((c) => c.key)).toEqual([
			'chandlery/overdue',
			'chandlery/soon-old',
			'chandlery/soon-new',
			'chandlery/later',
			'chandlery/none-old',
			'chandlery/none-new'
		]);
	});

	it('groups by sender and group, and only then', () => {
		const grouped = (id: string, from: string, group: string) =>
			mail({ id, from, payload: { decision: decision({ group }) } });
		const cards = buildCards(
			[
				grouped('a1', 'search-index', 'lists'),
				grouped('a2', 'search-index', 'lists'),
				grouped('b1', 'billing', 'lists'),
				grouped('a3', 'search-index', 'other')
			],
			NOW
		);
		expect(cards.map((c) => [c.key, c.questions.map((q) => q.id)])).toEqual(
			expect.arrayContaining([
				['search-index/lists', ['a1', 'a2']],
				['billing/lists', ['b1']],
				['search-index/other', ['a3']]
			])
		);
		expect(cards).toHaveLength(3);
	});

	it('gives a group the earliest open deadline and oldest ask', () => {
		const g = (id: string, deadline_ms: number | null, created_ms: number) =>
			mail({ id, deadline_ms, created_ms, payload: { decision: decision({ group: 'g' }) } });
		const [card] = buildCards(
			[
				g('x', NOW + 5 * HOUR, NOW - HOUR),
				g('y', NOW + 2 * HOUR, NOW - 4 * HOUR),
				g('z', null, NOW)
			],
			NOW,
			new Map([[askKey('chandlery', 'y'), { at_ms: NOW, sent: false, option_id: 'yes' }]])
		);
		expect(card.deadline_ms).toBe(NOW + 5 * HOUR);
		expect(card.asked_ms).toBe(NOW - 4 * HOUR);
		expect(card.questions.find((q) => q.id === 'y')?.answered).toMatchObject({ option_id: 'yes' });
	});

	it('drops plain requests and duplicate ids, and sinks answered cards', () => {
		const cards = buildCards(
			[
				mail({ id: 'done', deadline_ms: NOW - HOUR }),
				mail({ id: 'open' }),
				mail({ id: 'open', body: 'duplicate' }),
				mail({ id: 'plain', kind: 'request', payload: {} })
			],
			NOW,
			new Map([[askKey('chandlery', 'done'), { at_ms: NOW, sent: false }]])
		);
		expect(cards.map((c) => c.key)).toEqual(['chandlery/open', 'chandlery/done']);
	});

	it('keys asks by sender and id, so one id from two ships is two asks', () => {
		const cards = buildCards(
			[mail({ id: 'a', from: 'billing' }), mail({ id: 'a', from: 'chandlery' })],
			NOW,
			new Map([[askKey('chandlery', 'a'), { at_ms: NOW, sent: false, dismissed: true }]])
		);
		const questions = cards.flatMap((c) => c.questions);
		expect(questions).toHaveLength(2);
		expect(questions.find((q) => q.from === 'chandlery')?.answered).toMatchObject({
			dismissed: true
		});
		expect(questions.find((q) => q.from === 'billing')?.answered).toBeNull();
	});

	it('gives each ungrouped ask its own card, even when two ships reuse an id', () => {
		const cards = buildCards(
			[mail({ id: 'a', from: 'billing' }), mail({ id: 'a', from: 'chandlery' })],
			NOW
		);
		expect(cards.map((c) => c.key).sort()).toEqual(['billing/a', 'chandlery/a']);
		expect(new Set(cards.map((c) => c.key)).size).toBe(cards.length);
	});
});
