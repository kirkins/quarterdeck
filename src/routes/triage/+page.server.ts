import { fail } from '@sveltejs/kit';
import { isDecisionMail } from '#lib/decision.ts';
import { getPortal, loadItems } from '#lib/server/app.ts';
import { errorText, submitAnswer } from '#lib/server/submit.ts';
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

export const actions: Actions = {
	// A decision is answered exactly as on the Decisions page.
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
	},

	// A request or question gets a written reply; "Done" on a needs_hands step is one too.
	reply: async ({ request }) => {
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const text = form.get('text')?.toString().trim() ?? '';
		const echo = { id, option_id: null, text };
		if (text === '') return fail(400, { ...echo, error: 'Write a reply first.' });

		const result = await submitAnswer(id, { text }, (item) =>
			triageKind(item) === 'request' ? null : 'Only a request takes a written reply here.'
		);
		if (!result.ok) return fail(result.status, { ...echo, error: result.error });
		return { id, sent: result.sent };
	}
};
