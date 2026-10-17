import { describe, expect, it } from 'vitest';
import { formatAge, formatDeadline, formatSpan, urgencyOf } from './time.ts';

const NOW = 1_800_000_000_000;
const M = 60_000;
const H = 60 * M;

describe('time', () => {
	it('formats spans compactly', () => {
		expect(formatSpan(30_000)).toBe('under a minute');
		expect(formatSpan(45 * M)).toBe('45m');
		expect(formatSpan(2 * H + 10 * M)).toBe('2h 10m');
		expect(formatSpan(3 * H)).toBe('3h');
		expect(formatSpan(20 * H)).toBe('20h');
		expect(formatSpan(48 * H)).toBe('2d');
		expect(formatSpan(-2 * H)).toBe('2h');
	});

	it('describes deadlines and ages', () => {
		expect(formatDeadline(null, NOW)).toBe('No deadline');
		expect(formatDeadline(NOW + 40 * M, NOW)).toBe('Due in 40m');
		expect(formatDeadline(NOW - 2 * H, NOW)).toBe('Overdue by 2h');
		expect(formatAge(NOW - 10_000, NOW)).toBe('just now');
		expect(formatAge(NOW - 3 * H, NOW)).toBe('3h ago');
	});

	it('grades urgency', () => {
		expect(urgencyOf(null, NOW)).toBe('none');
		expect(urgencyOf(NOW - 1, NOW)).toBe('overdue');
		expect(urgencyOf(NOW + 59 * M, NOW)).toBe('soon');
		expect(urgencyOf(NOW + 5 * H, NOW)).toBe('today');
		expect(urgencyOf(NOW + 30 * H, NOW)).toBe('later');
	});
});
