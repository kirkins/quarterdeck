import { describe, expect, it } from 'vitest';
import { toastFor } from './toast.svelte.ts';

describe('toastFor', () => {
	it('confirms a sent answer, naming the ship', () => {
		expect(toastFor({ action: 'answer', from: 'billing', id: 'a', sent: true })).toEqual({
			text: 'Answer sent to billing',
			tone: 'ok'
		});
	});

	it('says plainly when an action was only logged', () => {
		expect(toastFor({ action: 'reply', from: 'billing', id: 'a', sent: false })?.text).toBe(
			'Reply logged · not sent'
		);
		expect(toastFor({ action: 'send', from: 'ops', id: 'r', sent: false, count: 2 })?.text).toBe(
			'2 comments logged · not sent'
		);
	});

	it('stays quiet for failures and for anything that is not an action result', () => {
		expect(
			toastFor({ action: 'answer', from: 'billing', id: 'a', sent: false, error: 'Not sent' })
		).toBeNull();
		expect(toastFor(null)).toBeNull();
		expect(toastFor({ action: 'answer' })).toBeNull();
		expect(toastFor({ action: 'unknown', sent: true })).toBeNull();
	});
});
