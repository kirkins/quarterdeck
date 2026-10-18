import { error, fail } from '@sveltejs/kit';
import { MAX_LIMIT as FIND_LIMIT } from '#lib/feed.ts';
import { askKey, type MailItem } from '#lib/decision.ts';
import {
	checkAnnotations,
	checkContent,
	commentRights,
	reportOf,
	REPORT_LIMITS
} from '#lib/report.ts';
import { triageKind } from '#lib/triage.ts';
import { getPortal, loadItems } from '#lib/server/app.ts';
import type { FeedEntry } from '#lib/shapes.ts';
import { loadFeed } from '#lib/server/feed.ts';
import { renderFrame } from '#lib/server/render.ts';
import { errorText, submitAnnotations } from '#lib/server/submit.ts';
import { notHeldHere } from '#lib/server/source.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * The ask a report belongs to, found by its key. Requests and decisions are in
 * captain.waiting; a notice or a report is not, so it is read from the feed's
 * open items. A plain report is found there too, and is read only.
 */
async function findAsk(key: string): Promise<MailItem | null> {
	const found = await loadItems();
	const waiting = found.items.find((m) => askKey(m.from, m.id) === key);
	if (waiting) return waiting;
	const read = await loadFeed({ limit: FIND_LIMIT, include_ship_mail: false, open_only: true });
	if (read.status === 'unsupported') return null;
	const entry = read.page.entries.find((e) => askKey(e.from, e.id) === key);
	return entry ? mailOf(entry) : null;
}

function mailOf(entry: FeedEntry): MailItem {
	return {
		id: entry.id,
		from: entry.from,
		to: entry.to,
		kind: entry.kind,
		body: entry.body,
		payload: entry.payload,
		task_id: entry.task_id,
		correlation: entry.correlation,
		request_kind: entry.request_kind,
		deadline_ms: entry.deadline_ms,
		created_ms: entry.created_ms ?? undefined,
		urgency: entry.urgency
	};
}

/** Why this ask cannot take the reply, or null. Checked before anything is sent. */
function refusal(item: MailItem): string | null {
	const rights = commentRights(item.kind, triageKind(item));
	if (rights.send) return null;
	if (rights.comment) return 'Sending comments on this report needs a Privateer update.';
	return 'Only a request or a notice takes comments.';
}

/**
 * True when the ship that sent the report runs on another machine. Its report
 * is stored there, and report.get on this machine cannot reach it yet.
 */
async function sentFromElsewhere(ship: string): Promise<boolean> {
	const read = await getPortal().source.snapshot();
	if (read.status !== 'ok') return false;
	const machine = read.snapshot.machines.find((m) => m.ships.some((s) => s.name === ship));
	return machine !== undefined && machine.link !== 'here';
}

export const load: PageServerLoad = async ({ params }) => {
	const { answers } = getPortal();
	const now = Date.now();
	const key = params.key;
	let item;
	try {
		item = await findAsk(key);
	} catch (error) {
		return {
			now,
			ask: null,
			error: `Could not reach Privateer: ${errorText(error)}`,
			elsewhere: null,
			frame: null
		};
	}
	if (!item) error(404, 'This report is no longer waiting.');

	const reported = reportOf(item.payload);
	if (!reported) error(404, 'This ask has no report.');
	if (!reported.ok) {
		return { now, ask: null, error: reported.error, elsewhere: null, frame: null };
	}

	const ref = reported.value;
	let content: string;
	try {
		if (ref.kind === 'inline') {
			content = ref.content;
		} else {
			const fetched = await getPortal().source.report(ref.report_id);
			const checked = checkContent(fetched.content);
			if (!checked.ok)
				return { now, ask: null, error: checked.error, elsewhere: null, frame: null };
			content = checked.value;
		}
	} catch (error) {
		if (ref.kind === 'by_id' && notHeldHere(error) && (await sentFromElsewhere(item.from))) {
			return {
				now,
				ask: null,
				error: null,
				elsewhere: { ship: item.from, title: ref.title },
				frame: null
			};
		}
		console.error('[quarterdeck] could not load report:', error);
		return {
			now,
			ask: null,
			error: `Could not load this report: ${errorText(error)}`,
			elsewhere: null,
			frame: null
		};
	}

	const format = ref.format;
	const rights = commentRights(item.kind, triageKind(item));
	return {
		now,
		error: null,
		elsewhere: null,
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
			canComment: rights.comment,
			canSend: rights.send
		},
		// The frame's document is built here, on the server, so the report never runs in this origin.
		frame: { ...renderFrame(format, content), format }
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
			refusal
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
