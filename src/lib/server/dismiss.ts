/**
 * Builds the captain's dismiss of one ask: `captain.dismiss {id, note?}`.
 * Ends the ask without a reply; a request or decision ends as dismissed, a
 * notice or report is marked acknowledged, a needs_hands ask closes.
 */
import type { MailItem } from '#lib/decision.ts';

/** Privateer has not stated a limit for dismiss notes; keep them short. */
export const MAX_NOTE = 2000;

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
	if (note && [...note].length > MAX_NOTE) {
		return { ok: false, error: `Keep the note under ${MAX_NOTE} characters.` };
	}
	const args: DismissArgs = { id: item.id, ...(note && { note }) };
	return { ok: true, args, note };
}
