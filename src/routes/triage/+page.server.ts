import { fail } from '@sveltejs/kit';
import { isDecisionMail } from '#lib/decision.ts';
import { getPortal, loadItems } from '#lib/server/app.ts';
import { errorText, submitAnswer, submitDismiss } from '#lib/server/submit.ts';
import { buildTriage, triageKind } from '#lib/triage.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const { answers } = getPortal();
	const now = Date.now();
	try {
		const { items, unavailable } = await loadItems();
		const { rows, ships } = buildTriage(items, now, answers);
		return { now, rows, ships, unavailable, error: null };
	} catch (error) {
		console.error('[quarterdeck] could not load triage:', error);
		return { now, rows: [], ships: [], unavailable: null, error: errorText(error) };
	}
};

/** Read the ask a form names: its sender and its mail id. */
function askOf(form: FormData) {
	return { from: String(form.get('from') ?? ''), id: String(form.get('id') ?? '') };
}

export const actions: Actions = {
	// A decision is answered exactly as on the Decisions page.
	answer: async ({ request }) => {
		const form = await request.formData();
		const ask = askOf(form);
		const option_id = form.get('option_id')?.toString() ?? null;
		const text = form.get('text')?.toString() ?? null;
		const echo = { action: 'answer', ...ask, option_id, text };

		const result = await submitAnswer(ask, { option_id, text }, (item) =>
			isDecisionMail(item) ? null : 'This ask is not a decision.'
		);
		if (!result.ok) return fail(result.status, { ...echo, error: result.error });
		return { action: 'answer', id: result.id, from: ask.from, sent: result.sent };
	},

	// A request or question gets a written reply; "Done" on a needs_hands step is one too.
	reply: async ({ request }) => {
		const form = await request.formData();
		const ask = askOf(form);
		const text = form.get('text')?.toString().trim() ?? '';
		const echo = { action: 'reply', ...ask, option_id: null, text };
		if (text === '') return fail(400, { ...echo, error: 'Write a reply first.' });

		const result = await submitAnswer(ask, { text }, (item) =>
			triageKind(item) === 'request' ? null : 'Only a request takes a written reply here.'
		);
		if (!result.ok) return fail(result.status, { ...echo, error: result.error });
		return { action: 'reply', id: result.id, from: ask.from, sent: result.sent };
	},

	// Closes an ask without a reply: a request, decision, approval or notice. Blockers are not mail.
	dismiss: async ({ request }) => {
		const form = await request.formData();
		const ask = askOf(form);
		const note = form.get('note')?.toString() ?? null;
		const echo = { action: 'dismiss', ...ask, option_id: null, text: note };

		const result = await submitDismiss(ask, note, (item) =>
			triageKind(item) === 'blocker'
				? 'Blocked items are not mail, so there is nothing to dismiss here.'
				: null
		);
		if (!result.ok) return fail(result.status, { ...echo, error: result.error });
		return { action: 'dismiss', id: result.id, from: ask.from, sent: result.sent };
	}
};
