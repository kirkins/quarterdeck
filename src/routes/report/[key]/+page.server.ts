import { error, fail } from '@sveltejs/kit';
import { askKey } from '#lib/decision.ts';
import { checkAnnotations, checkContent, reportOf, REPORT_LIMITS } from '#lib/report.ts';
import { triageKind } from '#lib/triage.ts';
import { getPortal, loadItems } from '#lib/server/app.ts';
import { renderFrame } from '#lib/server/render.ts';
import { errorText, submitAnnotations } from '#lib/server/submit.ts';
import type { Actions, PageServerLoad } from './$types';

/** Only a request or a notice carries a report the captain comments on. */
const REPORT_KINDS = new Set(['request', 'notice']);

export const load: PageServerLoad = async ({ params }) => {
	const { answers } = getPortal();
	const now = Date.now();
	let found;
	try {
		found = await loadItems();
	} catch (error) {
		return { now, ask: null, error: `Could not reach Privateer: ${errorText(error)}`, frame: null };
	}
	const key = params.key;
	const item = found.items.find((m) => askKey(m.from, m.id) === key);
	if (!item) error(404, 'This report is no longer waiting.');

	const reported = reportOf(item.payload);
	if (!reported) error(404, 'This ask has no report.');
	if (!reported.ok) {
		return { now, ask: null, error: reported.error, frame: null };
	}

	const ref = reported.value;
	let content: string;
	try {
		if (ref.kind === 'inline') {
			content = ref.content;
		} else {
			const fetched = await getPortal().source.report(ref.report_id);
			const checked = checkContent(fetched.content);
			if (!checked.ok) return { now, ask: null, error: checked.error, frame: null };
			content = checked.value;
		}
	} catch (error) {
		console.error('[quarterdeck] could not load report:', error);
		return {
			now,
			ask: null,
			error: `Could not load this report: ${errorText(error)}`,
			frame: null
		};
	}

	const format = ref.format;
	return {
		now,
		error: null,
		ask: {
			key,
			from: item.from,
			id: item.id,
			title: ref.title,
			kind: triageKind(item),
			asked_ms: item.asked_ms ?? item.created_ms ?? now,
			deadline_ms: typeof item.deadline_ms === 'number' ? item.deadline_ms : null,
			body: item.body ?? null,
			answered: answers.get(key) ?? null,
			canComment: REPORT_KINDS.has(triageKind(item))
		},
		// The frame's document is built here, on the server, so the report never runs in this origin.
		frame: { srcdoc: renderFrame(format, content), format }
	};
};

function askOf(form: FormData) {
	return { from: String(form.get('from') ?? ''), id: String(form.get('id') ?? '') };
}

export const actions: Actions = {
	// Sends every comment on the report, and the optional note, as one reply.
	send: async ({ request }) => {
		const form = await request.formData();
		const ask = askOf(form);
		const note = form.get('note')?.toString().trim() ?? '';
		const echo = { action: 'send' as const, ...ask };

		let raw: unknown;
		try {
			raw = JSON.parse(form.get('annotations')?.toString() ?? '[]');
		} catch {
			return fail(400, { ...echo, error: 'The comments did not arrive intact. Try again.' });
		}
		const annotations = checkAnnotations(raw);
		if (!annotations.ok) return fail(400, { ...echo, error: annotations.error });
		if ([...note].length > REPORT_LIMITS.note) {
			return fail(400, { ...echo, error: `Keep the note under ${REPORT_LIMITS.note} characters.` });
		}

		const result = await submitAnnotations(
			ask,
			{ annotations: annotations.value, note: note === '' ? null : note },
			(item) =>
				REPORT_KINDS.has(triageKind(item)) ? null : 'Only a request or a notice takes comments.'
		);
		if (!result.ok) return fail(result.status, { ...echo, error: result.error });
		return {
			action: 'send' as const,
			from: ask.from,
			id: result.id,
			sent: result.sent,
			count: annotations.value.length
		};
	}
};
