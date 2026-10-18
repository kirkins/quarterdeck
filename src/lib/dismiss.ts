/**
 * Wording for the Dismiss action, shared by the Triage rows and the decision
 * cards so both say the same thing. Browser-safe, like the rest of lib/.
 */

/** What the captain's dismiss is called for an ask, by its kind and whether it needs their hands. */
export function dismissLabel(kind: string, needsHands: boolean): string {
	if (needsHands) return 'Done, nothing to add';
	return kind === 'notice' ? 'Mark read' : 'Dismiss';
}

/** One line on the confirm step, saying what the press does. */
export function dismissDetail(label: string): string {
	if (label === 'Mark read') return 'Clear this notice from what is owed to you.';
	if (label === 'Done, nothing to add') return 'Close this step without a reply to the ship.';
	return 'Close this without a reply to the ship.';
}
