/**
 * Builds the captain's reply to a decision: a `mail.send` of kind "reply",
 * correlated to the asking mail and addressed to the asking ship.
 */
import type { Answered, Question } from '#lib/decision.ts';

/** Longest free-text answer or note we will send. */
export const MAX_TEXT = 2000;

export interface AnswerInput {
	option_id?: string | null;
	text?: string | null;
}

export interface ReplyAnswer {
	option_id?: string;
	text?: string;
}

/** Arguments for `privateer mail.send`. */
export interface MailSendArgs {
	from: 'captain';
	to: string;
	kind: 'reply';
	correlation: string;
	body: string;
	payload: { answer: ReplyAnswer };
	task_id?: string;
}

export type BuildResult =
	| { ok: true; args: MailSendArgs; answered: Omit<Answered, 'at_ms' | 'sent'> }
	| { ok: false; error: string };

/**
 * Validate the captain's input against the question and build the reply.
 *
 * - option only: `payload.answer = {option_id}`, body = the option's label
 * - option + text: `{option_id, text}`, body = "label — text"
 * - text only (the captain's own answer, on every decision): `{text}`, body = text
 *
 * `free_text_ok` is only a hint that the ship invites a written answer, so it
 * does not gate anything here.
 *
 * Older (choices-only) asks have no option ids a ship would understand, so
 * their reply carries the chosen words as text; the body says the same.
 */
export function buildReply(question: Question, input: AnswerInput): BuildResult {
	const optionId = input.option_id?.trim() || null;
	const text = input.text?.trim() || null;

	if (question.answered) return { ok: false, error: 'This question has already been answered.' };
	if (text && [...text].length > MAX_TEXT) {
		return { ok: false, error: `Keep the answer under ${MAX_TEXT} characters.` };
	}

	const option = optionId ? question.options.find((o) => o.id === optionId) : undefined;
	if (optionId && !option) return { ok: false, error: 'That option is no longer offered.' };
	if (!option && !text) return { ok: false, error: 'Choose an option or write your own answer.' };

	const body = option ? (text ? `${option.label} — ${text}` : option.label) : (text as string);
	const answer: ReplyAnswer =
		question.kind === 'decision'
			? { ...(option && { option_id: option.id }), ...(text && { text }) }
			: { text: body };

	const args: MailSendArgs = {
		from: 'captain',
		to: question.from,
		kind: 'reply',
		correlation: question.id,
		body,
		payload: { answer }
	};
	if (question.task_id) args.task_id = question.task_id;

	return {
		ok: true,
		args,
		answered: {
			...(option && { option_id: option.id, label: option.label }),
			...(text && { text })
		}
	};
}
