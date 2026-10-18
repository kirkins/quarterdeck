/**
 * Answering one ask, shared by the Decisions and Triage actions: find it in
 * what is owed now, check the kind may be answered here, build the reply and
 * send it (or log it, when sending is off). One path, so the two pages cannot
 * disagree about what an answer does.
 */
import { toQuestion, type MailItem } from '#lib/decision.ts';
import { buildReply, type AnswerInput } from './answer.ts';
import { getPortal, invalidateItems, loadItems } from './app.ts';
import { sendReply } from './source.ts';

/** Asks with a reply on its way, so a double tap cannot answer twice. */
const inflight = new Set<string>();

export type SubmitResult =
	{ ok: true; id: string; sent: boolean } | { ok: false; status: number; error: string };

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Answer the ask `id`. `refuse` returns why this ask cannot be answered here,
 * or null when it can.
 */
export async function submitAnswer(
	id: string,
	input: AnswerInput,
	refuse: (item: MailItem) => string | null
): Promise<SubmitResult> {
	const { source, answers, config } = getPortal();

	let found;
	try {
		// Always read fresh: the captain should never answer something already handled.
		found = await loadItems(true);
	} catch (error) {
		return { ok: false, status: 502, error: `Could not reach Privateer: ${errorText(error)}` };
	}
	const item = found.items.find((m) => m.id === id);
	if (!item) return { ok: false, status: 404, error: 'This ask is no longer waiting.' };

	const why = refuse(item);
	if (why) return { ok: false, status: 400, error: why };

	const now = Date.now();
	const question = toQuestion(item, now);
	question.answered = answers.get(id) ?? null;

	const built = buildReply(question, input);
	if (!built.ok) return { ok: false, status: 400, error: built.error };

	if (inflight.has(id))
		return { ok: false, status: 409, error: 'An answer is already being sent.' };
	inflight.add(id);
	try {
		const { sent } = await sendReply(source, config, built.args);
		answers.set(id, { ...built.answered, at_ms: now, sent });
		invalidateItems();
		return { ok: true, id, sent };
	} catch (error) {
		console.error('[quarterdeck] mail.send failed:', error);
		return { ok: false, status: 502, error: `Not sent: ${errorText(error)}` };
	} finally {
		inflight.delete(id);
	}
}
