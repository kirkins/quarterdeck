import { describe, expect, it } from 'vitest';
import { toQuestion, type MailItem } from '#lib/decision.ts';
import { buildReply, MAX_TEXT } from './answer.ts';

const NOW = 1_800_000_000_000;

function question(overrides: Partial<MailItem> = {}, decision: Record<string, unknown> = {}) {
	return toQuestion(
		{
			id: 'mail-1',
			from: 'billing',
			to: 'captain',
			kind: 'decision',
			task_id: 'billing-retries',
			body: 'Which retry policy?',
			payload: {
				decision: {
					question: 'Which retry policy?',
					options: [
						{ id: 'smart', label: 'Smart retries', what_happens: 'x', recommended: true },
						{ id: 'none', label: 'No retries', what_happens: 'y' }
					],
					...decision
				}
			},
			created_ms: NOW,
			...overrides
		},
		NOW
	);
}

describe('buildReply', () => {
	it('answers with an option: reply to the asker, correlated, label in the body', () => {
		const result = buildReply(question(), { option_id: 'smart' });
		expect(result).toEqual({
			ok: true,
			args: {
				from: 'captain',
				to: 'billing',
				kind: 'reply',
				correlation: 'mail-1',
				body: 'Smart retries',
				payload: { answer: { option_id: 'smart' } },
				task_id: 'billing-retries'
			},
			answered: { option_id: 'smart', label: 'Smart retries' }
		});
	});

	it('sends an option and a note together', () => {
		const result = buildReply(question(), { option_id: 'none', text: '  only after Friday ' });
		expect(result.ok && result.args.payload.answer).toEqual({
			option_id: 'none',
			text: 'only after Friday'
		});
		expect(result.ok && result.args.body).toBe('No retries — only after Friday');
	});

	it('accepts the captain’s own answer alone, whatever free_text_ok says', () => {
		for (const free_text_ok of [false, true]) {
			const result = buildReply(question({}, { free_text_ok }), { text: 'Something else' });
			expect(result.ok && result.args.payload.answer).toEqual({ text: 'Something else' });
			expect(result.ok && result.args.body).toBe('Something else');
			expect(result.ok && result.answered).toEqual({ text: 'Something else' });
		}
	});

	it('trims an own answer and rejects one that is empty or only spaces', () => {
		const result = buildReply(question(), { text: '  Not yet  ' });
		expect(result.ok && result.args.body).toBe('Not yet');
		expect(buildReply(question(), { text: '' })).toEqual({
			ok: false,
			error: 'Choose an option or write your own answer.'
		});
		expect(buildReply(question(), { text: '   ' }).ok).toBe(false);
	});

	it('rejects an own answer longer than MAX_TEXT, with or without an option', () => {
		const long = 'x'.repeat(MAX_TEXT + 1);
		expect(buildReply(question({}, { free_text_ok: true }), { text: long })).toEqual({
			ok: false,
			error: `Keep the answer under ${MAX_TEXT} characters.`
		});
		expect(buildReply(question(), { option_id: 'smart', text: long }).ok).toBe(false);
		expect(buildReply(question(), { text: 'x'.repeat(MAX_TEXT) }).ok).toBe(true);
	});

	it('rejects nothing, unknown options and second answers', () => {
		expect(buildReply(question(), {}).ok).toBe(false);
		expect(buildReply(question(), { option_id: '', text: '   ' }).ok).toBe(false);
		expect(buildReply(question(), { option_id: 'other' })).toMatchObject({
			ok: false,
			error: expect.stringMatching(/no longer offered/)
		});
		const answered = question();
		answered.answered = { at_ms: NOW, sent: false };
		expect(buildReply(answered, { option_id: 'smart' }).ok).toBe(false);
		expect(buildReply(answered, { text: 'again' }).ok).toBe(false);
	});

	it('carries task_id on the reply when the ask has one, and omits it when not', () => {
		const withTask = buildReply(question(), { text: 'Own words' });
		expect(withTask.ok && withTask.args.task_id).toBe('billing-retries');
		const withoutTask = buildReply(question({ task_id: null }), { option_id: 'smart' });
		expect(withoutTask.ok && 'task_id' in withoutTask.args).toBe(false);
	});

	it('answers older choices-only asks in words', () => {
		const legacy = toQuestion(
			{
				id: 'old-1',
				from: 'mobile-app',
				to: 'captain',
				kind: 'request',
				body: 'Ship today?',
				payload: { choices: ['Ship today', 'Wait'] }
			},
			NOW
		);
		const result = buildReply(legacy, { option_id: 'choice-2', text: 'until Monday' });
		expect(result.ok && result.args).toEqual({
			from: 'captain',
			to: 'mobile-app',
			kind: 'reply',
			correlation: 'old-1',
			body: 'Wait — until Monday',
			payload: { answer: { text: 'Wait — until Monday' } }
		});
	});
});
