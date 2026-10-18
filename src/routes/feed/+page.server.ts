import { fail } from '@sveltejs/kit';
import { askKey } from '#lib/decision.ts';
import { PAGE_LIMIT } from '#lib/feed.ts';
import { getPortal } from '#lib/server/app.ts';
import { loadFeed } from '#lib/server/feed.ts';
import { errorText, submitAnswer, submitDismiss } from '#lib/server/submit.ts';
import { triageKind } from '#lib/triage.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ depends }) => {
	// The page refreshes itself with invalidate('quarterdeck:feed') and after each action.
	depends('quarterdeck:feed');
	const now = Date.now();
	try {
		const result = await loadFeed({ limit: PAGE_LIMIT, include_ship_mail: false });
		if (result.status === 'unsupported') return { now, page: null, unsupported: true, error: null };
		return { now, page: result.page, unsupported: false, error: null };
	} catch (error) {
		console.error('[quarterdeck] could not load the feed:', error);
		return { now, page: null, unsupported: false, error: errorText(error) };
	}
};

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
export const actions: Actions = {
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
