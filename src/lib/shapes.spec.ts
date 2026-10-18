import { describe, expect, it } from 'vitest';
import {
	assemble,
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

describe('parseSnapshot (provisional fleet.snapshot)', () => {
	const full = {
		generated_ms: NOW,
		machines: [
			{
				name: 'atlas',
				reachable: true,
				changed_ms: NOW - 4000,
				routes: [{ name: 'primary', state: 'backing_off', until_ms: NOW + 9 * MIN }],
				ships: [
					{
						name: 'billing',
						scope: 'Invoices',
						presence: 'hosted',
						open_tasks: 3,
						jobs: [
							{
								id: 'j1',
								task_id: 'billing-retries',
								task_title: 'Retry policy',
								doing_now: 'Replaying declines',
								started_ms: NOW - 12 * MIN,
								heavy: true,
								waits: 'waiting for capacity'
							}
						]
					}
				]
			}
		],
		needs: [{ id: 'n1', ship: 'billing', kind: 'decision', source: 'mail' }]
	};

	it('reads the full shape', () => {
		const snap = parseSnapshot(full);
		expect(snap.generated_ms).toBe(NOW);
		expect(snap.machines).toHaveLength(1);
		const [machine] = snap.machines;
		expect(machine).toMatchObject({ name: 'atlas', reachable: true, changed_ms: NOW - 4000 });
		expect(machine.routes).toEqual([
			{
				name: 'primary',
				harness: null,
				model: null,
				cost: null,
				state: 'backing_off',
				until_ms: NOW + 9 * MIN,
				resets_at: null,
				last_error: null
			}
		]);
		expect(machine.ships[0]).toMatchObject({
			name: 'billing',
			scope: 'Invoices',
			presence: 'hosted',
			open_tasks: 3
		});
		expect(machine.ships[0].jobs[0]).toEqual({
			id: 'j1',
			task_id: 'billing-retries',
			task_title: 'Retry policy',
			doing_now: 'Replaying declines',
			started_ms: NOW - 12 * MIN,
			heavy: true,
			waits: 'waiting for capacity'
		});
		expect(snap.needs).toEqual([{ id: 'n1', ship: 'billing', kind: 'decision' }]);
	});

	it('fills gaps for a partial snapshot instead of failing', () => {
		const snap = parseSnapshot({ machines: [{ name: 'boreas', ships: [{ name: 'analytics' }] }] });
		expect(snap).toEqual({
			generated_ms: null,
			machines: [
				{
					name: 'boreas',
					reachable: false,
					changed_ms: null,
					routes: [],
					ships: [{ name: 'analytics', scope: null, presence: null, open_tasks: 0, jobs: [] }]
				}
			],
			needs: []
		});
	});

	it('ignores extra fields at every level', () => {
		const snap = parseSnapshot({
			...full,
			privateer_version: '9.9',
			machines: [{ ...full.machines[0], spend_usd: 4.2, ships: [{ name: 'x', hostname: 'h' }] }],
			needs: [{ id: 'n2', ship: 'x', kind: 'blocker', extra: true }]
		});
		expect(snap.machines[0].ships).toEqual([
			{ name: 'x', scope: null, presence: null, open_tasks: 0, jobs: [] }
		]);
		expect(snap.needs).toEqual([{ id: 'n2', ship: 'x', kind: 'blocker' }]);
	});

	it('returns an empty fleet when machines are missing or not a list', () => {
		expect(parseSnapshot({})).toEqual({ generated_ms: null, machines: [], needs: [] });
		expect(parseSnapshot({ machines: 'atlas' }).machines).toEqual([]);
		expect(parseSnapshot(null).machines).toEqual([]);
		expect(parseSnapshot('not an object').needs).toEqual([]);
	});

	it('drops machines, ships and needs without a name or id', () => {
		const snap = parseSnapshot({
			machines: [{ reachable: true }, { name: 'calypso', ships: [{ scope: 'no name' }] }],
			needs: [{ id: 'n3' }, { ship: 'billing' }]
		});
		expect(snap.machines.map((m) => m.name)).toEqual(['calypso']);
		expect(snap.machines[0].ships).toEqual([]);
		expect(snap.needs).toEqual([]);
	});
});

describe('parseSnapshot routes (provisional, for the spend view)', () => {
	it('reads every route field, and leaves the ones Privateer omits null', () => {
		const snap = parseSnapshot({
			machines: [
				{
					name: 'atlas',
					reachable: true,
					routes: [
						{
							name: 'free-pool',
							harness: 'tidewater',
							model: 'small-free',
							cost: 'free',
							state: 'backing_off',
							until_ms: NOW + 9 * MIN,
							last_error: 'Upstream answered 429'
						},
						{ name: 'credits-reserve', cost: 'credits', state: 'available' },
						{ state: 'available' }
					]
				}
			]
		});
		expect(snap.machines[0].routes).toEqual([
			{
				name: 'free-pool',
				harness: 'tidewater',
				model: 'small-free',
				cost: 'free',
				state: 'backing_off',
				until_ms: NOW + 9 * MIN,
				resets_at: null,
				last_error: 'Upstream answered 429'
			},
			{
				name: 'credits-reserve',
				harness: null,
				model: null,
				cost: 'credits',
				state: 'available',
				until_ms: null,
				resets_at: null,
				last_error: null
			}
		]);
	});

	it('reads resets_at for a capped route', () => {
		const snap = parseSnapshot({
			machines: [
				{
					name: 'boreas',
					reachable: true,
					routes: [{ name: 'plan-main', cost: 'plan', state: 'capped', resets_at: NOW + HOUR }]
				}
			]
		});
		expect(snap.machines[0].routes[0].resets_at).toBe(NOW + HOUR);
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
