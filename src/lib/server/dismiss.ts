/**
 * Builds the captain's dismiss of one ask: `captain.dismiss {id, note?}`.
 * Ends the ask without a reply; a request or decision ends as dismissed, a
 * notice or report is marked acknowledged, a needs_hands ask closes.
 */
import type { MailItem } from '#lib/decision.ts';
import { MAX_TEXT } from './answer.ts';

/** Arguments for `privateer captain.dismiss`. */
export interface DismissArgs {
	id: string;
	note?: string;
}

export type DismissBuild =
	{ ok: true; args: DismissArgs; note: string | null } | { ok: false; error: string };

/** Validate an optional note and build the dismiss for `item`. */
export function buildDismiss(item: MailItem, rawNote: string | null | undefined): DismissBuild {
	const note = rawNote?.trim() || null;
	if (note && [...note].length > MAX_TEXT) {
		return { ok: false, error: `Keep the note under ${MAX_TEXT} characters.` };
	}
	const args: DismissArgs = { id: item.id, ...(note && { note }) };
	return { ok: true, args, note };
}
