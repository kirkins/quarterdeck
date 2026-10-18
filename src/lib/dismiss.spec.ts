import { describe, expect, it } from 'vitest';
import { dismissDetail, dismissLabel } from './dismiss.ts';
import { failureFrom } from './form.ts';

describe('dismissLabel', () => {
	it('says Dismiss for requests and decisions, Mark read for notices', () => {
		expect(dismissLabel('request', false)).toBe('Dismiss');
		expect(dismissLabel('decision', false)).toBe('Dismiss');
		expect(dismissLabel('approval', false)).toBe('Dismiss');
		expect(dismissLabel('notice', false)).toBe('Mark read');
	});

	it('says Done, nothing to add when the captain has to do the step', () => {
		expect(dismissLabel('request', true)).toBe('Done, nothing to add');
		expect(dismissLabel('notice', true)).toBe('Done, nothing to add');
	});
});

describe('dismissDetail', () => {
	it('says what each press does', () => {
		expect(dismissDetail('Mark read')).toMatch(/notice/);
		expect(dismissDetail('Done, nothing to add')).toMatch(/step/);
		expect(dismissDetail('Dismiss')).toMatch(/without a reply/);
	});
});

describe('failureFrom', () => {
	const echo = {
		action: 'dismiss',
		from: 'billing',
		id: 'm-1',
		option_id: null,
		text: 'a note',
		error: 'This ask is no longer waiting.'
	};

	it('reads the failure of one of the named actions', () => {
		expect(failureFrom(echo, ['dismiss'])).toEqual({
			action: 'dismiss',
			from: 'billing',
			id: 'm-1',
			error: 'This ask is no longer waiting.',
			option_id: null,
			text: 'a note'
		});
	});

	it('ignores a failure from another action, a success, and no form at all', () => {
		expect(failureFrom(echo, ['answer', 'reply'])).toBeNull();
		expect(
			failureFrom({ action: 'dismiss', id: 'm-1', from: 'x', sent: true }, ['dismiss'])
		).toBeNull();
		expect(failureFrom(undefined, ['dismiss'])).toBeNull();
	});
});
