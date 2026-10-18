/**
 * Answering and dismissing one ask, shared by the Decisions and Triage
 * actions: find it in what is owed now, check the kind may take this action,
 * build the write and send it (or log it, when sending is off). One path, so
 * the two pages cannot disagree about what an action does.
 */
import { askKey, toQuestion, type Answered, type MailItem } from '#lib/decision.ts';
import { reportOf, type Annotation } from '#lib/report.ts';
import { buildReply, type AnswerInput, type ReplyArgs } from './answer.ts';
import { getPortal, invalidateItems, loadItems } from './app.ts';
import { buildDismiss } from './dismiss.ts';
import { sendDismiss, sendReply } from './source.ts';

/** Asks with a write on their way, so a double tap cannot act twice. */
const inflight = new Set<string>();

/** Which ask: the sender and the mail id, as the forms post them. */
export interface AskRef {
	from: string;
	id: string;
}

export type SubmitResult =
	{ ok: true; id: string; sent: boolean } | { ok: false; status: number; error: string };

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

type Refuse = (item: MailItem) => string | null;

/** What an action will do to one ask: the write to run, and what to remember. */
type Prepared =
	| { error: string }
	| { record: Omit<Answered, 'at_ms' | 'sent'>; run: () => Promise<{ sent: boolean }> };

/** Find the ask in what is owed now, and check it may take this action. */
async function locate(
	ref: AskRef,
	refuse: Refuse
): Promise<{ ok: true; item: MailItem } | Extract<SubmitResult, { ok: false }>> {
	let found;
	try {
		// Always read fresh: the captain should never act on something already handled.
		found = await loadItems(true);
	} catch (error) {
		return { ok: false, status: 502, error: `Could not reach Privateer: ${errorText(error)}` };
	}
	const key = askKey(ref.from, ref.id);
	const item = found.items.find((m) => askKey(m.from, m.id) === key);
	if (!item) return { ok: false, status: 404, error: 'This ask is no longer waiting.' };
	const why = refuse(item);
	if (why) return { ok: false, status: 400, error: why };
	return { ok: true, item };
}

/** Run one write for an ask, at most once at a time, and record it in the answers map. */
async function act(
	ref: AskRef,
	refuse: Refuse,
	prepare: (item: MailItem, now: number) => Prepared
): Promise<SubmitResult> {
	const { answers } = getPortal();
	const found = await locate(ref, refuse);
	if (!found.ok) return found;
	const key = askKey(found.item.from, found.item.id);

	const now = Date.now();
	const prepared = prepare(found.item, now);
	if ('error' in prepared) return { ok: false, status: 400, error: prepared.error };

	if (inflight.has(key)) {
		return { ok: false, status: 409, error: 'An answer is already being sent.' };
	}
	inflight.add(key);
	try {
		const { sent } = await prepared.run();
		answers.set(key, { ...prepared.record, at_ms: now, sent });
		invalidateItems();
		return { ok: true, id: found.item.id, sent };
	} catch (error) {
		console.error('[quarterdeck] write failed:', error);
		return { ok: false, status: 502, error: `Not sent: ${errorText(error)}` };
	} finally {
		inflight.delete(key);
	}
}

/**
 * Answer the ask. `refuse` returns why this ask cannot be answered here, or
 * null when it can.
 */
export function submitAnswer(
	ref: AskRef,
	input: AnswerInput,
	refuse: Refuse
): Promise<SubmitResult> {
	const { source, answers, config } = getPortal();
	return act(ref, refuse, (item, now) => {
		const question = toQuestion(item, now);
		question.answered = answers.get(askKey(item.from, item.id)) ?? null;
		const built = buildReply(question, input);
		if (!built.ok) return { error: built.error };
		return {
			record: built.answered,
			run: () => sendReply(source, config, built.args)
		};
	});
}

/** Close the ask without a reply. The note, if any, is kept on the record. */
export function submitDismiss(
	ref: AskRef,
	rawNote: string | null,
	refuse: Refuse
): Promise<SubmitResult> {
	const { source, answers, config } = getPortal();
	return act(ref, refuse, (item) => {
		if (answers.has(askKey(item.from, item.id))) {
			return { error: 'This ask has already been answered or dismissed.' };
		}
		const built = buildDismiss(item, rawNote);
		if (!built.ok) return { error: built.error };
		return {
			record: { dismissed: true, ...(built.note && { text: built.note }) },
			run: () => sendDismiss(source, config, built.args)
		};
	});
}

/** The comments on one report, and an optional note, sent as one reply. */
export interface ReportInput {
	annotations: Annotation[];
	note: string | null;
}

/**
 * Send a report's comments as one `captain.reply`. The body names how many
 * comments there are and carries the captain's note, if any. A report can be
 * sent once: its record in the answers map is what says so.
 */
export function submitAnnotations(
	ref: AskRef,
	input: ReportInput,
	refuse: Refuse
): Promise<SubmitResult> {
	const { source, answers, config } = getPortal();
	return act(ref, refuse, (item) => {
		const key = askKey(item.from, item.id);
		if (answers.has(key)) return { error: 'This ask has already been answered or dismissed.' };
		const reported = reportOf(item.payload);
		if (!reported || !reported.ok) return { error: 'This ask has no report to comment on.' };
		const { annotations, note } = input;
		if (annotations.length === 0 && !note) {
			return { error: 'Add a comment or a note first.' };
		}
		const count = annotations.length;
		const summary =
			count === 0 ? '' : `${count} comment${count === 1 ? '' : 's'} on ${reported.value.title}`;
		const body = [summary, note ?? ''].filter((part) => part !== '').join('\n\n');
		const args: ReplyArgs = { id: item.id, body, payload: { annotations } };
		return {
			record: { text: body },
			run: () => sendReply(source, config, args)
		};
	});
}
