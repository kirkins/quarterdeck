import { describe, expect, it } from 'vitest';
import { assemble, parseCaptainWaiting, parseRuntimeNeeds } from './shapes.ts';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

/** A mail record as captain.waiting returns it (privateer src/mail.rs `message`). */
function mail(overrides: Record<string, unknown> = {}) {
	return {
		seq: 1,
		id: 'm-1',
		from: 'billing',
		to: 'captain',
		kind: 'decision',
		correlation: null,
		task_id: 'billing-retries',
		request_kind: null,
		body: 'Which policy?',
		payload: { decision: { question: 'Which policy?', options: [] } },
		urgency: 'high',
		deadline_ms: NOW + 30 * MIN,
		created_ms: NOW - 90 * MIN,
		state: 'open',
		...overrides
	};
}

/** One entry of captain.waiting's `waiting` list (privateer src/captain.rs `waiting`). */
function entry(m: Record<string, unknown>, step: string | null = null) {
	return {
		ship: m.from,
		asked_ms: m.created_ms,
		age_ms: NOW - (m.created_ms as number),
		step,
		mail: m
	};
}

describe('parseCaptainWaiting', () => {
	it('reads the waiting list and keeps the mail record, its payload and its urgency', () => {
		const [item] = parseCaptainWaiting(
			{ now_ms: NOW, hands_on: [], waiting: [entry(mail())] },
			NOW
		);
		expect(item.id).toBe('m-1');
		expect(item.from).toBe('billing');
		expect(item.kind).toBe('decision');
		expect(item.urgency).toBe('high');
		expect(item.deadline_ms).toBe(NOW + 30 * MIN);
		expect(item.asked_ms).toBe(NOW - 90 * MIN);
		expect(item.age_ms).toBe(90 * MIN);
		expect(item.hands_on).toBeNull();
		expect((item.payload as { decision: { question: string } }).decision.question).toBe(
			'Which policy?'
		);
	});

	it('takes the exact step from the entry as hands_on', () => {
		const [item] = parseCaptainWaiting(
			{ waiting: [entry(mail({ kind: 'request', payload: {} }), 'Approve the DNS change.')] },
			NOW
		);
		expect(item.hands_on).toBe('Approve the DNS change.');
	});

	it('skips entries without a mail id, and tolerates a missing list', () => {
		expect(parseCaptainWaiting({ waiting: [{ ship: 'x' }, { mail: {} }, 3] }, NOW)).toEqual([]);
		expect(parseCaptainWaiting(null, NOW)).toEqual([]);
		expect(parseCaptainWaiting({}, NOW)).toEqual([]);
	});
});

describe('parseRuntimeNeeds', () => {
	it('reads a mail decision with its choices, correlated to the mail id', () => {
		const { items, unavailable } = parseRuntimeNeeds(
			{
				available: true,
				items: [
					{
						id: 'o:mail:m-2',
						source: 'mail',
						source_id: 'm-2',
						kind: 'decision',
						ship: 'mobile-app',
						question: 'Android first?',
						choices: ['Yes', 'No', 7],
						correlation: 'm-2',
						created_ms: NOW - MIN,
						actions: ['mail.send']
					}
				]
			},
			NOW
		);
		expect(unavailable).toBeNull();
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			id: 'm-2',
			from: 'mobile-app',
			kind: 'decision',
			body: 'Android first?',
			payload: { choices: ['Yes', 'No'] },
			actions: ['mail.send'],
			asked_ms: NOW - MIN
		});
	});

	it('reads urgency, deadline, asked time and mail id that Privateer now sends', () => {
		const { items } = parseRuntimeNeeds(
			{
				available: true,
				items: [
					{
						id: 'o:mail:m-9',
						source: 'mail',
						source_id: 'm-9',
						kind: 'request',
						ship: 'cdn-edge',
						question: 'Retry the warm-up?',
						task_id: 'cdn',
						mail_id: 'm-9',
						correlation: 'm-9',
						urgency: 'high',
						deadline_ms: NOW + HOUR,
						asked_ms: NOW - 2 * MIN,
						created_ms: NOW - 9 * MIN
					}
				]
			},
			NOW
		);
		expect(items[0]).toMatchObject({
			id: 'm-9',
			kind: 'request',
			urgency: 'high',
			deadline_ms: NOW + HOUR,
			asked_ms: NOW - 2 * MIN,
			age_ms: 2 * MIN
		});
	});

	it('takes the mail id over the correlation, and keeps a notice a notice', () => {
		const [item] = parseRuntimeNeeds(
			{
				available: true,
				items: [
					{
						id: 'o:mail:n-1',
						source: 'mail',
						source_id: 'other',
						kind: 'notice',
						ship: 'backups',
						question: 'Backup finished.',
						mail_id: 'n-1',
						correlation: 'n-1',
						created_ms: NOW
					}
				]
			},
			NOW
		).items;
		expect(item).toMatchObject({ id: 'n-1', kind: 'notice', urgency: 'normal', deadline_ms: null });
	});

	it('defaults timing on needs from an older Privateer that sends none', () => {
		const [item] = parseRuntimeNeeds(
			{
				available: true,
				items: [
					{
						id: 'o:mail:m-4',
						source: 'mail',
						kind: 'decision',
						ship: 'billing',
						correlation: 'm-4',
						question: 'Which?',
						choices: ['A', 'B'],
						created_ms: NOW - MIN
					}
				]
			},
			NOW
		).items;
		expect(item).toMatchObject({ urgency: 'normal', deadline_ms: null, asked_ms: NOW - MIN });
	});

	it('reads an approval with what is being granted, and no choices', () => {
		const [item] = parseRuntimeNeeds(
			{
				available: true,
				items: [
					{
						id: 'o:mail:m-3',
						source: 'mail',
						kind: 'approval',
						ship: 'billing',
						correlation: 'm-3',
						question: 'Deploy?',
						artifact: 'api 1.2',
						environment: 'production-eu',
						created_ms: NOW,
						actions: ['approval.grant', 'approval.deny']
					}
				]
			},
			NOW
		).items;
		expect(item.kind).toBe('approval');
		expect(item.payload).toEqual({ artifact: 'api 1.2', environment: 'production-eu' });
	});

	it('reads blockers from jobs, schedules and workspaces, with their summary', () => {
		const { items } = parseRuntimeNeeds(
			{
				available: true,
				items: [
					{
						id: 'o:job:j1',
						source: 'job',
						ship: 's',
						kind: 'blocker',
						evidence: 'orphaned_job',
						status: 'orphaned',
						summary: 'Lost its worker.',
						created_ms: NOW - 60 * MIN,
						actions: []
					},
					{
						id: 'o:schedule:n',
						source: 'schedule',
						ship: 't',
						kind: 'blocker',
						evidence: 'scheduling_fault',
						status: 'fault',
						created_ms: NOW - 2 * MIN
					},
					{
						id: 'o:workspace:w',
						source: 'workspace',
						ship: 'u',
						kind: 'blocker',
						evidence: 'workspace_disk_wait',
						status: 'queued',
						created_ms: NOW - 3 * MIN
					}
				]
			},
			NOW
		);
		expect(items.map((i) => [i.id, i.kind, i.evidence])).toEqual([
			['o:job:j1', 'blocker', 'orphaned_job'],
			['o:schedule:n', 'blocker', 'scheduling_fault'],
			['o:workspace:w', 'blocker', 'workspace_disk_wait']
		]);
		expect(items[0].body).toBe('Lost its worker.');
		expect(items[1].body).toMatch(/fault/);
		expect(items[0].actions).toEqual([]);
	});

	it('says why it is unavailable, and yields nothing', () => {
		expect(parseRuntimeNeeds({ available: false, reason: 'schema missing' }, NOW)).toEqual({
			items: [],
			unavailable: 'schema missing'
		});
		expect(parseRuntimeNeeds(null, NOW).unavailable).toMatch(/unavailable/);
	});

	it('skips unknown sources and needs without an id', () => {
		const { items } = parseRuntimeNeeds(
			{
				available: true,
				items: [{ id: 'x', source: 'weather' }, { source: 'mail' }, { id: 'y', source: 'mail' }]
			},
			NOW
		);
		expect(items).toEqual([]);
	});
});

describe('assemble', () => {
	it('merges a mail both queries report, with captain.waiting winning on kind and payload', () => {
		const captain = {
			waiting: [
				entry(
					mail({
						id: 'm-1',
						kind: 'decision',
						payload: { decision: { question: 'Q?', options: [] } }
					})
				)
			]
		};
		const needs = {
			available: true,
			items: [
				{
					id: 'o:mail:m-1',
					source: 'mail',
					kind: 'decision',
					ship: 'billing',
					correlation: 'm-1',
					choices: ['A'],
					actions: ['mail.send']
				}
			]
		};
		const { items, unavailable } = assemble(captain, needs, NOW);
		expect(unavailable).toBeNull();
		expect(items).toHaveLength(1);
		expect(items[0].payload).toEqual({ decision: { question: 'Q?', options: [] } });
		expect(items[0].urgency).toBe('high');
		expect(items[0].actions).toEqual(['mail.send']);
	});

	it('keeps the same mail id from two ships apart', () => {
		const captain = {
			waiting: [
				entry(mail({ id: 'same', from: 'billing' })),
				entry(mail({ id: 'same', from: 'storefront' }))
			]
		};
		expect(assemble(captain, null, NOW).items).toHaveLength(2);
	});

	it('still returns captain.waiting when runtime.needs is unavailable', () => {
		const result = assemble(
			{ waiting: [entry(mail())] },
			{ available: false, reason: 'down' },
			NOW
		);
		expect(result.items).toHaveLength(1);
		expect(result.unavailable).toBe('down');
	});
});
