import { fail } from '@sveltejs/kit';
import { buildCards, isDecisionMail, toQuestion } from '#lib/decision.ts';
import { buildReply } from '#lib/server/answer.ts';
import { getPortal } from '#lib/server/app.ts';
import { sendReply } from '#lib/server/source.ts';
import type { Actions, PageServerLoad } from './$types';

/** Asks with a reply on its way, so a double tap cannot answer twice. */
const inflight = new Set<string>();

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const load: PageServerLoad = async () => {
	const { source, answers } = getPortal();
	const now = Date.now();
	try {
		const cards = buildCards(await source.waiting(), now, answers);
		const open = cards.reduce((n, c) => n + c.questions.filter((q) => !q.answered).length, 0);
		return { now, cards, open, error: null };
	} catch (error) {
		console.error('[quarterdeck] could not load decisions:', error);
		return { now, cards: [], open: null, error: message(error) };
	}
};

export const actions: Actions = {
	answer: async ({ request }) => {
		const { source, answers, config } = getPortal();
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const option_id = form.get('option_id')?.toString() ?? null;
		const text = form.get('text')?.toString() ?? null;
		const echo = { id, option_id, text };

		let items;
		try {
			items = await source.waiting();
		} catch (error) {
			return fail(502, { ...echo, error: `Could not reach Privateer: ${message(error)}` });
		}
		const item = items.find((m) => m.id === id && isDecisionMail(m));
		if (!item) return fail(404, { ...echo, error: 'This ask is no longer waiting.' });

		const now = Date.now();
		const question = toQuestion(item, now);
		question.answered = answers.get(id) ?? null;

		const built = buildReply(question, { option_id, text });
		if (!built.ok) return fail(400, { ...echo, error: built.error });

		if (inflight.has(id)) return fail(409, { ...echo, error: 'An answer is already being sent.' });
		inflight.add(id);
		try {
			const { sent } = await sendReply(source, config, built.args);
			answers.set(id, { ...built.answered, at_ms: now, sent });
			return { id, sent };
		} catch (error) {
			console.error('[quarterdeck] mail.send failed:', error);
			return fail(502, { ...echo, error: `Not sent: ${message(error)}` });
		} finally {
			inflight.delete(id);
		}
	}
};
