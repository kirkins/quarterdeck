/**
 * Toasts: a short line that confirms something happened, then goes. They are
 * read out politely and never carry the only copy of anything: every action
 * that raises one also shows its result where it was made.
 */
export type ToastTone = 'ok' | 'info' | 'warn';

export interface Toast {
	id: number;
	text: string;
	tone: ToastTone;
}

const SHOW_MS = 3_600;

export const toasts = $state<Toast[]>([]);
let counter = 0;

export function toast(text: string, tone: ToastTone = 'ok'): void {
	counter += 1;
	const id = counter;
	toasts.push({ id, text, tone });
	// At most three at once: the oldest makes room.
	if (toasts.length > 3) toasts.splice(0, toasts.length - 3);
	setTimeout(() => dropToast(id), SHOW_MS);
}

export function dropToast(id: number): void {
	const index = toasts.findIndex((t) => t.id === id);
	if (index !== -1) toasts.splice(index, 1);
}

/** The words for a form action that worked, from what every action echoes back. */
export function toastFor(form: unknown): { text: string; tone: ToastTone } | null {
	if (typeof form !== 'object' || form === null) return null;
	const f = form as Record<string, unknown>;
	if (typeof f.action !== 'string' || typeof f.sent !== 'boolean' || 'error' in f) return null;
	const to = typeof f.from === 'string' && f.from !== '' ? f.from : 'the ship';
	const logged = { tone: 'info' as const };
	switch (f.action) {
		case 'answer':
			return f.sent
				? { text: `Answer sent to ${to}`, tone: 'ok' }
				: { text: 'Answer logged · not sent', ...logged };
		case 'reply':
			return f.sent
				? { text: `Reply sent to ${to}`, tone: 'ok' }
				: { text: 'Reply logged · not sent', ...logged };
		case 'dismiss':
			return f.sent
				? { text: `Dismissed · ${to} was told`, tone: 'ok' }
				: { text: 'Dismissed · logged only', ...logged };
		case 'send': {
			const n = typeof f.count === 'number' ? f.count : null;
			const what = n === null ? 'Comments' : `${n} ${n === 1 ? 'comment' : 'comments'}`;
			return f.sent
				? { text: `${what} sent to ${to}`, tone: 'ok' }
				: { text: `${what} logged · not sent`, ...logged };
		}
		default:
			return null;
	}
}
