import { fail } from '@sveltejs/kit';
import { buildCards, isDecisionMail, type MailItem } from '#lib/decision.ts';
import { getPortal, loadItems } from '#lib/server/app.ts';
import { errorText, submitAnswer, submitDismiss } from '#lib/server/submit.ts';
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

/** Read the ask a form names: its sender and its mail id. */
function askOf(form: FormData) {
	return { from: String(form.get('from') ?? ''), id: String(form.get('id') ?? '') };
}

/** Only decisions are answered or dismissed here; everything else is on Triage. */
const decisionOnly = (item: MailItem) =>
	isDecisionMail(item) ? null : 'This ask is not a decision.';

export const actions: Actions = {
	answer: async ({ request }) => {
		const form = await request.formData();
		const ask = askOf(form);
		const option_id = form.get('option_id')?.toString() ?? null;
		const text = form.get('text')?.toString() ?? null;
		const echo = { action: 'answer', ...ask, option_id, text };

		const result = await submitAnswer(ask, { option_id, text }, decisionOnly);
		if (!result.ok) return fail(result.status, { ...echo, error: result.error });
		return { action: 'answer', id: result.id, from: ask.from, sent: result.sent };
	},

	dismiss: async ({ request }) => {
		const form = await request.formData();
		const ask = askOf(form);
		const note = form.get('note')?.toString() ?? null;
		const echo = { action: 'dismiss', ...ask, option_id: null, text: note };

		const result = await submitDismiss(ask, note, decisionOnly);
		if (!result.ok) return fail(result.status, { ...echo, error: result.error });
		return { action: 'dismiss', id: result.id, from: ask.from, sent: result.sent };
	}
};
