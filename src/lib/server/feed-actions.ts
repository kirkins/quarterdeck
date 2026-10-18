import { fail, type Actions } from '@sveltejs/kit';
import { askKey } from '#lib/decision.ts';
import { getPortal } from './app.ts';
import { submitAnswer, submitDismiss } from './submit.ts';
import { triageKind } from '#lib/triage.ts';

/** Read the ask a form names: its sender and its mail id. */
function askOf(form: FormData) {
	return { from: String(form.get('from') ?? ''), id: String(form.get('id') ?? '') };
}

/**
 * What this portal recorded for the ask, so the page can close that one message
 * in place: an older ask is not in the first page the page reloads.
 */
function recordOf(ask: { from: string; id: string }) {
	return getPortal().answers.get(askKey(ask.from, ask.id)) ?? null;
}

/**
 * Answer in place. A decision or a request takes an answer; anything else is
 * closed with a dismiss. The same write path as Decisions and Triage.
 */
export const feedActions: Actions = {
	answer: async ({ request }) => {
		const form = await request.formData();
		const ask = askOf(form);
		const option_id = form.get('option_id')?.toString() ?? null;
		const text = form.get('text')?.toString() ?? null;
		const echo = { action: 'answer', ...ask, option_id, text };

		const result = await submitAnswer(ask, { option_id, text }, (item) =>
			['decision', 'request'].includes(triageKind(item))
				? null
				: 'This ask is closed with Dismiss, not answered.'
		);
		if (!result.ok) return fail(result.status, { ...echo, error: result.error });
		return {
			action: 'answer',
			id: result.id,
			from: ask.from,
			sent: result.sent,
			record: recordOf(ask)
		};
	},

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
		return {
			action: 'dismiss',
			id: result.id,
			from: ask.from,
			sent: result.sent,
			record: recordOf(ask)
		};
	}
};
