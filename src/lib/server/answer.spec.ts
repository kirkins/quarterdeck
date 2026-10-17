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

	it('allows text alone only when free_text_ok', () => {
		expect(buildReply(question(), { text: 'Something else' })).toEqual({
			ok: false,
			error: expect.stringMatching(/needs one of the options/)
		});
		const free = buildReply(question({}, { free_text_ok: true }), { text: 'Something else' });
		expect(free.ok && free.args.payload.answer).toEqual({ text: 'Something else' });
		expect(free.ok && free.args.body).toBe('Something else');
	});

	it('rejects nothing, unknown options, long text and second answers', () => {
		expect(buildReply(question(), {}).ok).toBe(false);
		expect(buildReply(question(), { option_id: '', text: '   ' }).ok).toBe(false);
		expect(buildReply(question(), { option_id: 'other' })).toMatchObject({
			ok: false,
			error: expect.stringMatching(/no longer offered/)
		});
		expect(buildReply(question(), { option_id: 'smart', text: 'x'.repeat(MAX_TEXT + 1) }).ok).toBe(
			false
		);
		const answered = question();
		answered.answered = { at_ms: NOW, sent: false };
		expect(buildReply(answered, { option_id: 'smart' }).ok).toBe(false);
	});

	it('omits task_id when the ask has none', () => {
		const result = buildReply(question({ task_id: null }), { option_id: 'smart' });
		expect(result.ok && 'task_id' in result.args).toBe(false);
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
