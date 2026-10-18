import { describe, expect, it } from 'vitest';
import { isShipName, matchTools, shipFacts, tabOf } from './ship.ts';
import { parseShipProfile, parseSnapshot } from './shapes.ts';

describe('isShipName', () => {
	it('accepts the names ships have', () => {
		for (const name of ['billing', 'docs-site', 'search-index', 'v2.app', 'a_b']) {
			expect(isShipName(name)).toBe(true);
		}
	});

	it('refuses anything that is not a plain name', () => {
		for (const name of [
			'',
			'-x',
			'../etc',
			'a/b',
			'a b',
			'<script>',
			'a?b=c',
			'a#b',
			'x'.repeat(65)
		]) {
			expect(isShipName(name)).toBe(false);
		}
	});
});

describe('tabOf', () => {
	it('opens the conversation unless the tools are asked for', () => {
		expect(tabOf(null)).toBe('conversation');
		expect(tabOf('tools')).toBe('tools');
		expect(tabOf('nonsense')).toBe('conversation');
	});
});

describe('shipFacts', () => {
	const snapshot = parseSnapshot({
		generated_ms: 1,
		machines: [
			{ name: 'atlas', reachable: true, changed_ms: 1 },
			{ name: 'calypso', reachable: false, as_of_ms: 1 }
		],
		ships: [
			{
				name: 'billing',
				machine: 'atlas',
				presence: 'hosted',
				presence_since_ms: 5,
				open_tasks_total: 3,
				jobs: [
					{
						id: 'j1',
						task_title: 'Retries',
						state: 'running',
						doing: { text: 'Replaying' }
					}
				]
			},
			{ name: 'mobile-app', machine: 'calypso', presence: 'asleep', open_tasks_total: 0 }
		],
		needs: [
			{ id: 'n1', ship: 'billing', machine: 'atlas', kind: 'decision' },
			{ id: 'n2', ship: 'billing', machine: null, kind: 'blocker' },
			{ id: 'n3', ship: 'billing', machine: 'boreas', kind: 'blocker' },
			{ id: 'n4', ship: 'other', machine: 'atlas' }
		]
	});

	it('places a ship on its machine, with its crew and the needs that name it on that machine', () => {
		expect(shipFacts(snapshot, 'billing')).toEqual({
			machine: 'atlas',
			reachable: true,
			presence: 'hosted',
			presenceSince: 5,
			openTasks: 3,
			jobs: [
				{
					id: 'j1',
					task_id: null,
					task_title: 'Retries',
					kind: null,
					state: 'running',
					heavy: false,
					created_ms: null,
					spawned_ms: null,
					started_ms: null,
					model_route: null,
					doing: { text: 'Replaying', at_ms: null, report_id: null },
					wait: null
				}
			],
			needs: 2
		});
	});

	it('says the machine is not reachable for a ship on an unreachable machine', () => {
		expect(shipFacts(snapshot, 'mobile-app')).toMatchObject({
			machine: 'calypso',
			reachable: false,
			presence: 'asleep',
			jobs: []
		});
	});

	it('returns null for a ship the fleet does not place on any machine', () => {
		expect(shipFacts(snapshot, 'nowhere')).toBeNull();
	});
});

describe('matchTools', () => {
	const profile = parseShipProfile(
		{
			skills: [
				{ name: 'retry-policy', description: 'Draft retries' },
				{ name: 'invoice-pdf', description: 'Render invoices' }
			],
			mcp_servers: [
				{ name: 'stripe', url: 'https://mcp.example.test/s', credentials: ['STRIPE_API_KEY'] }
			],
			plugins: [{ name: 'metrics' }]
		},
		'billing'
	);

	it('keeps everything for an empty query', () => {
		const all = matchTools(profile, '  ');
		expect(all.skills).toHaveLength(2);
		expect(all.mcpServers).toHaveLength(1);
		expect(all.plugins).toHaveLength(1);
	});

	it('matches names, descriptions, URLs and credential names, ignoring case', () => {
		expect(matchTools(profile, 'RETRY').skills.map((s) => s.name)).toEqual(['retry-policy']);
		expect(matchTools(profile, 'render').skills.map((s) => s.name)).toEqual(['invoice-pdf']);
		expect(matchTools(profile, 'example').mcpServers).toHaveLength(1);
		expect(matchTools(profile, 'stripe_api').mcpServers).toHaveLength(1);
		expect(matchTools(profile, 'nothing-like-this')).toEqual({
			skills: [],
			mcpServers: [],
			plugins: []
		});
	});
});
