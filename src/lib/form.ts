/**
 * A failed form action, as the page reads it back. Each action echoes what it
 * was given, so the failure can be shown on the ask it belongs to.
 */
export interface Failure {
	action: string;
	from: string;
	id: string;
	error: string;
	option_id: string | null;
	text: string | null;
}

/** The failure from the last action, if it was one of `actions` and names an ask. */
export function failureFrom(form: unknown, actions: readonly string[]): Failure | null {
	if (typeof form !== 'object' || form === null || !('error' in form)) return null;
	const echo = form as Record<string, unknown>;
	if (typeof echo.id !== 'string' || typeof echo.action !== 'string') return null;
	if (!actions.includes(echo.action)) return null;
	return {
		action: echo.action,
		from: typeof echo.from === 'string' ? echo.from : '',
		id: echo.id,
		error: String(echo.error),
		option_id: typeof echo.option_id === 'string' ? echo.option_id : null,
		text: typeof echo.text === 'string' ? echo.text : null
	};
}
