import { fail } from '@sveltejs/kit';
import { buildCards, isDecisionMail } from '#lib/decision.ts';
import { getPortal, loadItems } from '#lib/server/app.ts';
import { errorText, submitAnswer } from '#lib/server/submit.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const { answers } = getPortal();
	const now = Date.now();
	try {
		const { items } = await loadItems();
		const cards = buildCards(items, now, answers);
		const open = cards.reduce((n, c) => n + c.questions.filter((q) => !q.answered).length, 0);
		return { now, cards, open, error: null };
	} catch (error) {
		console.error('[quarterdeck] could not load decisions:', error);
		return { now, cards: [], open: null, error: errorText(error) };
	}
};

export const actions: Actions = {
	answer: async ({ request }) => {
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const option_id = form.get('option_id')?.toString() ?? null;
		const text = form.get('text')?.toString() ?? null;
		const echo = { id, option_id, text };

		const result = await submitAnswer(id, { option_id, text }, (item) =>
			isDecisionMail(item) ? null : 'This ask is not a decision.'
		);
		if (!result.ok) return fail(result.status, { ...echo, error: result.error });
		return { id, sent: result.sent };
	}
};
