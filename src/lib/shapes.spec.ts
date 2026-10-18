import { describe, expect, it } from 'vitest';
import {
	assemble,
	keepTruncated,
	mergeSnapshot,
	sinceFixture,
	sinceOf,
	parseCaptainWaiting,
	parseRoutesShow,
	parseRuntimeNeeds,
	parseSnapshot,
	parseUsageRecords,
	parseShipProfile,
	parseUsageSummary,
	displayUrl
} from './shapes.ts';

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

	it('takes the message kind from mail_kind, and the step from needs_hands', () => {
		const need = (extra: Record<string, unknown>) => ({
			id: 'o:mail:m-9',
			source: 'mail',
			mail_id: 'm-9',
			kind: 'decision',
			ship: 'billing',
			question: 'Rotate the key?',
			...extra
		});
		const read = (extra: Record<string, unknown>) =>
			parseRuntimeNeeds({ available: true, items: [need(extra)] }, NOW).items[0];

		expect(read({ mail_kind: 'request' }).kind).toBe('request');
		expect(read({ mail_kind: 'decision' }).kind).toBe('decision');
		expect(read({}).kind).toBe('decision');
		expect(read({ needs_hands: { step: 'run rotate-key' } }).hands_on).toBe('run rotate-key');
		expect(read({ needs_hands: 'run rotate-key' }).hands_on).toBe('run rotate-key');
		expect(read({ needs_hands: true }).hands_on).toBe('Needs your hands; see the message.');
		expect(read({ needs_hands: null }).hands_on).toBeNull();
		expect(read({}).hands_on).toBeNull();
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
				entry(mail({ id: 'same', from: 'chandlery' }))
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

describe('parseSnapshot (fleet.snapshot)', () => {
	const full = {
		schema_version: 1,
		generated_ms: NOW,
		machine: 'atlas',
		machines: [
			{
				name: 'atlas',
				link: 'here',
				reachable: true,
				error: null,
				via: 'direct',
				as_of_ms: null,
				changed_ms: NOW - 4000,
				unchanged: false,
				truncated: false,
				unknown: ['answered:billing'],
				routes: [
					{
						name: 'free-pool',
						route: 'tidewater small-free',
						cost: 'free',
						tier: 'small',
						state: 'backing_off',
						until_ms: NOW + 540_000,
						error: 'Upstream answered 429',
						allowance: null
					}
				]
			}
		],
		ships: [
			{
				name: 'billing',
				machine: 'atlas',
				liaison: 'captain',
				harness: 'tidewater',
				hosted: true,
				presence: 'hosted',
				presence_since_ms: NOW - 3600_000,
				unread: 2,
				open_requests: 1,
				open_tasks: [
					{ id: 'billing-retries', title: 'Retries', status: 'running', handoff_to: null }
				],
				open_tasks_total: 3,
				jobs: [
					{
						id: 'job-billing-42',
						task_id: 'billing-retries',
						task_title: 'Retry policy',
						kind: 'crew',
						state: 'queued',
						heavy: true,
						created_ms: NOW - 9000,
						spawned_ms: null,
						started_ms: null,
						model_route: 'plan-main',
						doing: null,
						wait: {
							for: 'capacity',
							since_ms: NOW - 5000,
							job_id: null,
							park: null,
							behind: []
						}
					},
					{
						id: 'job-billing-43',
						task_id: 'receipts',
						task_title: 'Receipts',
						kind: 'crew',
						state: 'running',
						heavy: false,
						created_ms: NOW - 9000,
						spawned_ms: NOW - 8000,
						started_ms: NOW - 7000,
						model_route: 'free-pool',
						doing: { text: 'Replaying declines', at_ms: NOW - 1000, report_id: 'r1' },
						wait: null
					}
				],
				jobs_total: 2
			}
		],
		needs: [
			{
				id: 'm-billing-retries',
				ship: 'billing',
				machine: 'atlas',
				kind: 'decision',
				source: 'mail',
				question: 'Which policy?',
				mail_id: 'm-billing-retries',
				as_of_ms: null,
				actions: ['approve']
			}
		]
	};

	it('reads every field the contract names', () => {
		const snap = parseSnapshot(full);
		expect(snap.schema_version).toBe(1);
		expect(snap.generated_ms).toBe(NOW);
		expect(snap.machines[0]).toMatchObject({
			name: 'atlas',
			link: 'here',
			reachable: true,
			via: 'direct',
			as_of_ms: null,
			changed_ms: NOW - 4000,
			unchanged: false,
			truncated: false,
			unknown: ['answered:billing']
		});
		expect(snap.machines[0].routes[0]).toEqual({
			name: 'free-pool',
			route: 'tidewater small-free',
			cost: 'free',
			tier: 'small',
			state: 'backing_off',
			until_ms: NOW + 540_000,
			error: 'Upstream answered 429',
			allowance: null
		});
		expect(snap.needs[0]).toEqual({
			id: 'm-billing-retries',
			ship: 'billing',
			machine: 'atlas',
			kind: 'decision',
			source: 'mail',
			question: 'Which policy?',
			mail_id: 'm-billing-retries',
			as_of_ms: null,
			actions: ['approve']
		});
	});

	it('places each top-level ship on its machine, with its tasks and jobs', () => {
		const ship = parseSnapshot(full).machines[0].ships[0];
		expect(ship).toMatchObject({
			name: 'billing',
			machine: 'atlas',
			hosted: true,
			presence: 'hosted',
			presence_since_ms: NOW - 3600_000,
			unread: 2,
			open_requests: 1,
			open_tasks_total: 3,
			jobs_total: 2
		});
		expect(ship.open_tasks).toEqual([
			{ id: 'billing-retries', title: 'Retries', status: 'running', handoff_to: null }
		]);
		expect(ship.jobs[0]).toMatchObject({
			state: 'queued',
			heavy: true,
			doing: null,
			wait: { for: 'capacity', since_ms: NOW - 5000, behind: [] }
		});
		expect(ship.jobs[1]).toMatchObject({
			state: 'running',
			doing: { text: 'Replaying declines', at_ms: NOW - 1000, report_id: 'r1' },
			wait: null
		});
	});

	it('reads a parked job behind another job, and an allowance', () => {
		const raw = {
			machines: [
				{
					name: 'boreas',
					reachable: true,
					routes: [
						{
							name: 'plan-main',
							state: 'available',
							allowance: {
								shape: 'window',
								window_ends_ms: NOW,
								weekly_ends_ms: NOW,
								window_used: 3,
								week_used: 9,
								last_used_ms: NOW
							}
						}
					]
				}
			],
			ships: [
				{
					name: 'chandlery',
					machine: 'boreas',
					jobs: [
						{
							id: 'j2',
							state: 'parked',
							wait: {
								for: 'job',
								job_id: 'j1',
								park: 'waiting for the layout',
								behind: [{ job_id: 'j1', ship: 'chandlery', unhealthy: true }]
							}
						}
					]
				}
			]
		};
		const snap = parseSnapshot(raw);
		expect(snap.machines[0].ships[0].jobs[0].wait).toEqual({
			for: 'job',
			since_ms: null,
			job_id: 'j1',
			park: 'waiting for the layout',
			behind: [{ job_id: 'j1', ship: 'chandlery', unhealthy: true }]
		});
		expect(snap.machines[0].routes[0].allowance).toEqual({
			shape: 'window',
			window_ends_ms: NOW,
			weekly_ends_ms: NOW,
			window_used: 3,
			week_used: 9,
			last_used_ms: NOW
		});
	});

	it('reads an unknown presence as unknown, not as an absent one', () => {
		const ship = parseSnapshot({
			machines: [{ name: 'a' }],
			ships: [
				{ name: 's', machine: 'a', presence: 'waking' },
				{ name: 't', machine: 'a' }
			]
		}).machines[0].ships;
		expect(ship.map((s) => s.presence)).toEqual(['unknown', 'unknown']);
	});

	it('keeps an unreachable machine with its as-of time and last-known ships', () => {
		const snap = parseSnapshot({
			machines: [
				{ name: 'calypso', reachable: false, error: 'timed out', as_of_ms: NOW - 3600_000 }
			],
			ships: [{ name: 'mobile-app', machine: 'calypso', presence: 'hosted' }]
		});
		expect(snap.machines[0]).toMatchObject({
			reachable: false,
			error: 'timed out',
			as_of_ms: NOW - 3600_000
		});
		expect(snap.machines[0].ships.map((s) => s.name)).toEqual(['mobile-app']);
	});

	it('fills gaps for a partial snapshot instead of failing', () => {
		const snap = parseSnapshot({ machines: [{ name: 'boreas', ships: [{ name: 'analytics' }] }] });
		expect(snap.machines).toEqual([
			expect.objectContaining({ name: 'boreas', reachable: false, ships: [], routes: [] })
		]);
		expect(snap.needs).toEqual([]);
	});

	it('returns an empty snapshot for anything that is not an object', () => {
		expect(parseSnapshot({})).toEqual({
			schema_version: null,
			generated_ms: null,
			machines: [],
			needs: []
		});
		expect(parseSnapshot({ machines: 'atlas' }).machines).toEqual([]);
		expect(parseSnapshot(null).machines).toEqual([]);
		expect(parseSnapshot('not an object').needs).toEqual([]);
	});
});

describe('sinceOf and mergeSnapshot (fleet.snapshot since)', () => {
	const read = (machines: unknown[], ships: unknown[] = [], needs: unknown[] = []) =>
		parseSnapshot({ generated_ms: NOW, machines, ships, needs });

	const held = read(
		[
			{
				name: 'atlas',
				reachable: true,
				changed_ms: 100,
				routes: [{ name: 'plan-main', state: 'available' }]
			},
			{ name: 'boreas', reachable: true, changed_ms: 200 }
		],
		[
			{
				name: 'billing',
				machine: 'atlas',
				presence: 'hosted',
				jobs: [{ id: 'j1', state: 'running' }]
			},
			{ name: 'search', machine: 'boreas', presence: 'asleep' }
		],
		[{ id: 'old', ship: 'billing', machine: 'atlas' }]
	);

	it('builds the since token from each machine that has a change time', () => {
		expect(sinceOf(held)).toEqual({ atlas: 100, boreas: 200 });
		expect(sinceOf(read([{ name: 'calypso', reachable: false }]))).toBeNull();
		expect(sinceOf(null)).toBeNull();
	});

	it('keeps the held ships and routes of an unchanged machine, and takes the new needs in full', () => {
		const next = read(
			[
				{ name: 'atlas', reachable: true, changed_ms: 100, unchanged: true },
				{ name: 'boreas', reachable: true, changed_ms: 250, unchanged: false }
			],
			[{ name: 'search', machine: 'boreas', presence: 'hosted' }],
			[{ id: 'new', ship: 'search', machine: 'boreas' }]
		);
		const merged = mergeSnapshot(held, next);
		expect(merged?.machines.map((m) => m.name)).toEqual(['atlas', 'boreas']);
		expect(merged?.machines[0].ships.map((s) => s.name)).toEqual(['billing']);
		expect(merged?.machines[0].routes.map((r) => r.name)).toEqual(['plan-main']);
		expect(merged?.machines[1].ships.map((s) => s.presence)).toEqual(['hosted']);
		expect(merged?.needs.map((n) => n.id)).toEqual(['new']);
	});

	it('returns null when an unchanged machine has nothing held to stand on', () => {
		const next = read([{ name: 'atlas', reachable: true, changed_ms: 100, unchanged: true }]);
		expect(mergeSnapshot(null, next)).toBeNull();
		expect(mergeSnapshot(read([{ name: 'boreas' }]), next)).toBeNull();
	});

	it('takes a changed machine as sent, without the held one', () => {
		const next = read([{ name: 'atlas', reachable: true, changed_ms: 300, unchanged: false }]);
		const merged = mergeSnapshot(held, next);
		expect(merged?.machines[0].ships).toEqual([]);
		expect(merged?.machines[0].routes).toEqual([]);
	});

	it('answers a fixture as Privateer answers since: unchanged machines lose their ships and routes, needs stay', () => {
		const fixture = {
			machines: [
				{ name: 'atlas', changed_ms: 100, routes: [{ name: 'plan-main' }] },
				{ name: 'boreas', changed_ms: 250, routes: [] }
			],
			ships: [
				{ name: 'billing', machine: 'atlas' },
				{ name: 'search', machine: 'boreas' }
			],
			needs: [{ id: 'n1', ship: 'billing', machine: 'atlas' }]
		};
		const answered = sinceFixture(fixture, { atlas: 100, boreas: 200 }) as typeof fixture & {
			machines: Record<string, unknown>[];
		};
		expect(answered.machines[0]).toEqual({
			name: 'atlas',
			changed_ms: 100,
			unchanged: true,
			routes: []
		});
		expect(answered.machines[1]).toEqual(fixture.machines[1]);
		expect(answered.ships.map((s) => s.name)).toEqual(['search']);
		expect(answered.needs).toEqual(fixture.needs);
		// A machine with no token held is not unchanged, nor is one whose token moved on.
		expect(sinceFixture(fixture, { atlas: 99 })).toMatchObject({
			machines: [{ name: 'atlas', changed_ms: 100 }, { name: 'boreas' }]
		});
		expect(sinceFixture(fixture, {})).toEqual(fixture);
	});

	it('keeps the held ships of a truncated machine that came back with none', () => {
		const held = read(
			[{ name: 'atlas', reachable: true, changed_ms: 100 }],
			[{ name: 'billing', machine: 'atlas', presence: 'hosted' }]
		);
		const next = read([{ name: 'atlas', reachable: true, changed_ms: 150, truncated: true }]);
		const kept = keepTruncated(held, next);
		expect(kept.machines[0].truncated).toBe(true);
		expect(kept.machines[0].ships.map((s) => s.name)).toEqual(['billing']);
	});

	it('takes a truncated machine as sent when it still has ships, and a full one as sent', () => {
		const held = read(
			[{ name: 'atlas', reachable: true, changed_ms: 100 }],
			[{ name: 'billing', machine: 'atlas', presence: 'hosted' }]
		);
		const partial = read(
			[{ name: 'atlas', reachable: true, changed_ms: 150, truncated: true }],
			[{ name: 'search', machine: 'atlas', presence: 'asleep' }]
		);
		expect(keepTruncated(held, partial).machines[0].ships.map((s) => s.name)).toEqual(['search']);
		const full = read([{ name: 'atlas', reachable: true, changed_ms: 150 }]);
		expect(keepTruncated(held, full).machines[0].ships).toEqual([]);
		expect(
			keepTruncated(null, read([{ name: 'atlas', truncated: true }])).machines[0].ships
		).toEqual([]);
	});

	it('reads a desk and a stow state, with the stow left unknown when Privateer does not say', () => {
		const parsed = read([
			{ name: 'atlas', desk: true, stowed: true },
			{ name: 'boreas', desk: false, stowed: 'yes' }
		]);
		expect(parsed.machines.map((m) => [m.desk, m.stowed])).toEqual([
			[true, true],
			[false, null]
		]);
	});
});

describe('parseRoutesShow', () => {
	it('reads each route config and the try order lists', () => {
		const config = parseRoutesShow({
			routes: {
				'plan-main': {
					cost: 'plan',
					note: 'Shared with the captain',
					options: ['--large'],
					manifest: 'routes/plan.toml'
				}
			},
			crew: ['free-pool', 'plan-main'],
			errand: ['plan-main'],
			first_mate: []
		});
		expect(config.routes).toEqual([
			{
				name: 'plan-main',
				cost: 'plan',
				note: 'Shared with the captain',
				options: ['--large'],
				manifest: 'routes/plan.toml',
				allowance_resets_utc: null
			}
		]);
		expect(config.order).toEqual({
			crew: ['free-pool', 'plan-main'],
			errand: ['plan-main'],
			first_mate: []
		});
	});

	it('reads order lists under an order key too, and tolerates nothing at all', () => {
		expect(parseRoutesShow({ order: { crew: ['a'] } }).order.crew).toEqual(['a']);
		expect(parseRoutesShow(null)).toEqual({
			routes: [],
			order: { crew: [], errand: [], first_mate: [] }
		});
		expect(parseRoutesShow({ routes: { '': { cost: 'free' }, bad: 'nope' } }).routes).toEqual([]);
	});
});

describe('parseUsageSummary', () => {
	it('reads totals per group, keeping a null where the harness reports nothing', () => {
		const summary = parseUsageSummary({
			since_ms: NOW - 24 * HOUR,
			group_by: 'ship',
			groups: [
				{
					key: 'billing',
					jobs: 3,
					usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1 },
					gaps: []
				},
				{ key: 'analytics', jobs: 2, usage: null, gaps: ['ferry'] },
				{
					key: 'docs',
					jobs: 1,
					usage: { input: 4, output: null, cacheRead: null, cacheWrite: null }
				}
			]
		});
		expect(summary.groups[0].usage).toEqual({
			input: 100,
			output: 20,
			cacheRead: 5,
			cacheWrite: 1,
			totalTokens: 126
		});
		expect(summary.groups[1]).toEqual({ key: 'analytics', jobs: 2, usage: null, gaps: ['ferry'] });
		expect(summary.groups[2].usage?.totalTokens).toBe(4);
		expect(summary.group_by).toBe('ship');
	});

	it('keeps a reported totalTokens over the derived sum', () => {
		const summary = parseUsageSummary({
			groups: [{ key: 'x', usage: { input: 1, output: 2, totalTokens: 10 } }]
		});
		expect(summary.groups[0].usage?.totalTokens).toBe(10);
	});

	it('gives no totalTokens when no count is present', () => {
		const summary = parseUsageSummary({ groups: [{ key: 'x', usage: {} }] });
		expect(summary.groups[0].usage).toEqual({
			input: null,
			output: null,
			cacheRead: null,
			cacheWrite: null,
			totalTokens: null
		});
	});

	it('is empty and calm for a missing or malformed reply', () => {
		expect(parseUsageSummary(undefined).groups).toEqual([]);
		expect(parseUsageSummary({ groups: [{ jobs: 1 }, 7] }).groups).toEqual([]);
	});
});

describe('parseUsageRecords', () => {
	it('drops records missing their time, machine, ship, route or harness', () => {
		const records = parseUsageRecords({
			records: [
				{
					ts_ms: NOW,
					machine: 'atlas',
					ship: 'billing',
					route: 'plan-main',
					harness: 'tidewater',
					jobs: 1,
					usage: null
				},
				{ ts_ms: NOW, machine: 'atlas', ship: 'billing', route: 'plan-main' }
			]
		});
		expect(records).toHaveLength(1);
		expect(records[0].usage).toBeNull();
	});
});

describe('parseShipProfile', () => {
	const full = {
		ship: 'billing',
		machine: 'atlas',
		hosted: true,
		sleep: { policy: 'after_idle', idle_minutes: 7.5 },
		first_mate: {
			harness: 'pi',
			options: {
				model: 'large',
				max_turns: 40,
				api_key: '<set>',
				retry: { max: 3, token: '<set>' }
			}
		},
		routes: {
			first_mate: { list: 'ship', names: ['plan-main'] },
			crew: { list: 'fleet', names: ['plan-main', 'free-pool'] },
			errand: { list: 'none', names: [] }
		},
		charter: { actions: ['read the ledger', 'reply to the captain'], active: false },
		permissions: {
			fleet_mode: 'ask',
			fleet_rules: ['Never charge a card'],
			ship_rules: []
		},
		tool_bundles: { bounded: true, selected: { skills: ['retry-policy'] } },
		skills: [{ name: 'retry-policy', description: 'Draft a policy' }, { name: 'bare' }],
		mcp_servers: [
			{
				name: 'stripe',
				url: 'https://mcp.example.test?token=do-not-show-this',
				description: 'Test-mode tools',
				credentials: ['STRIPE_API_KEY']
			},
			{
				name: 'ledger-db',
				url: 'https://user:do-not-show-this@db.example.test/mcp',
				credentials: ['DB_PASSWORD']
			}
		],
		plugins: [{ name: 'attended/mail.ts', description: 'Mailbox' }]
	};

	it('reads a full profile into one shape', () => {
		const profile = parseShipProfile(full, 'billing');
		expect(profile).toMatchObject({
			ship: 'billing',
			machine: 'atlas',
			hosted: true,
			sleep: { policy: 'after_idle', idle_minutes: 7.5 },
			firstMate: { harness: 'pi' },
			charter: { actions: ['read the ledger', 'reply to the captain'], active: false },
			permissions: { fleetMode: 'ask', fleetRules: ['Never charge a card'] },
			toolBundles: { bounded: true, error: null },
			skills: [
				{ name: 'retry-policy', description: 'Draft a policy' },
				{ name: 'bare', description: null }
			],
			plugins: [{ name: 'attended/mail.ts', description: 'Mailbox' }]
		});
		expect(profile.routes).toEqual([
			{ kind: 'first_mate', list: 'ship', names: ['plan-main'] },
			{ kind: 'crew', list: 'fleet', names: ['plan-main', 'free-pool'] },
			{ kind: 'errand', list: 'none', names: [] }
		]);
	});

	it('keeps no ship rules, since a ship has none of its own', () => {
		expect(parseShipProfile(full, 'billing').permissions).not.toHaveProperty('shipRules');
	});

	it('reads a route list it does not know as not reported', () => {
		const { routes } = parseShipProfile({ routes: { crew: { list: 'sideways' } } }, 'x');
		expect(routes).toEqual([{ kind: 'crew', list: null, names: [] }]);
	});

	it('masks a secret-looking option to set or not set, and never keeps its value', () => {
		const { firstMate } = parseShipProfile(full, 'billing');
		expect(firstMate.options).toEqual([
			{ name: 'model', value: 'large', secret: false, set: true },
			{ name: 'max_turns', value: '40', secret: false, set: true },
			{ name: 'api_key', value: null, secret: true, set: true },
			{
				name: 'retry',
				value: '{"max":3,"token":"<set>"}',
				secret: false,
				set: true
			}
		]);
		expect(JSON.stringify(firstMate)).not.toContain('do-not-show-this');
	});

	it('hides a value Privateer masked, even under a name this list does not know', () => {
		const { firstMate } = parseShipProfile(
			{ first_mate: { options: { 'session-id': '<set>' } } },
			'x'
		);
		expect(firstMate.options).toEqual([
			{ name: 'session-id', value: null, secret: true, set: true }
		]);
	});

	it('scrubs credentials from a URL held in a non-secret option', () => {
		const profile = {
			first_mate: {
				harness: 'claude',
				options: {
					base_url: 'https://user:do-not-show-this@api.example.test/v1?token=do-not-show-this'
				}
			}
		};
		const { firstMate } = parseShipProfile(profile, 'billing');
		expect(firstMate.options).toEqual([
			{
				name: 'base_url',
				value: 'https://api.example.test/v1?token=hidden',
				secret: false,
				set: true
			}
		]);
		expect(JSON.stringify(firstMate)).not.toContain('do-not-show-this');
	});

	it('masks secret keys and scrubs URLs nested inside a non-secret option', () => {
		const profile = {
			first_mate: {
				harness: 'pi',
				options: {
					env: {
						REGION: 'eu',
						API_KEY: 'do-not-show-this',
						nested: [{ session: 'do-not-show-this' }, 'https://u:do-not-show-this@x.test/']
					}
				}
			}
		};
		const [env] = parseShipProfile(profile, 'billing').firstMate.options;
		expect(env.secret).toBe(false);
		expect(env.value).not.toContain('do-not-show-this');
		expect(JSON.parse(env.value ?? '')).toEqual({
			REGION: 'eu',
			API_KEY: '<set>',
			nested: [{ session: '<set>' }, 'https://x.test/']
		});
	});

	it('keeps credential names only, and hides secret query values and user names in URLs', () => {
		const { mcpServers } = parseShipProfile(full, 'billing');
		expect(mcpServers).toEqual([
			{
				name: 'stripe',
				url: 'https://mcp.example.test/?token=hidden',
				description: 'Test-mode tools',
				credentials: ['STRIPE_API_KEY']
			},
			{
				name: 'ledger-db',
				url: 'https://db.example.test/mcp',
				description: null,
				credentials: ['DB_PASSWORD']
			}
		]);
		expect(JSON.stringify(mcpServers)).not.toContain('do-not-show-this');
	});

	it('reads the bounded plan, and the error that stops it being built', () => {
		const { toolBundles } = parseShipProfile(
			{
				tool_bundles: { bounded: true, selected: {}, error: 'bundle retry: no SKILL.md' }
			},
			'x'
		);
		expect(toolBundles).toEqual({ bounded: true, error: 'bundle retry: no SKILL.md' });
		expect(parseShipProfile({ tool_bundles: { bounded: false } }, 'x').toolBundles).toEqual({
			bounded: false,
			error: null
		});
	});

	it('reads a sleep policy of not_hosted, and no idle time', () => {
		expect(
			parseShipProfile({ sleep: { policy: 'not_hosted', idle_minutes: null } }, 'x').sleep
		).toEqual({ policy: 'not_hosted', idle_minutes: null });
	});

	it('reads a partial or empty profile without failing, with gaps as null, empty or false', () => {
		expect(parseShipProfile({ machine: 'atlas' }, 'docs')).toEqual({
			ship: 'docs',
			machine: 'atlas',
			hosted: null,
			sleep: { policy: null, idle_minutes: null },
			firstMate: { harness: null, options: [] },
			routes: [],
			charter: { actions: [], active: null },
			permissions: { fleetMode: null, fleetRules: [] },
			toolBundles: { bounded: null, error: null },
			skills: [],
			mcpServers: [],
			plugins: []
		});
		expect(parseShipProfile(null, 'docs').skills).toEqual([]);
		expect(parseShipProfile({ skills: [{ description: 'no name' }, 'text'] }, 'x').skills).toEqual(
			[]
		);
	});
});

describe('displayUrl', () => {
	it('drops a user name and password, and hides secret-looking query values', () => {
		expect(displayUrl('https://a:b@host.test/x?api_key=1&page=2')).toBe(
			'https://host.test/x?api_key=hidden&page=2'
		);
	});

	it('returns null for what is not a URL', () => {
		expect(displayUrl('not a url')).toBeNull();
		expect(displayUrl(42)).toBeNull();
	});
});
