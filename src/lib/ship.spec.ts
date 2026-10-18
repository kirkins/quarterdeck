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
		machines: [
			{
				name: 'atlas',
				reachable: true,
				ships: [
					{
						name: 'billing',
						presence: 'hosted',
						open_tasks: 3,
						jobs: [{ id: 'j1', task_title: 'Retries', doing_now: 'Replaying' }]
					}
				]
			},
			{ name: 'calypso', reachable: false, ships: [{ name: 'mobile-app' }] }
		],
		needs: [
			{ id: 'n1', ship: 'billing', kind: 'decision' },
			{ id: 'n2', ship: 'billing', kind: 'blocker' },
			{ id: 'n3', ship: 'other' }
		]
	});

	it('places a ship on its machine, with its crew and the needs that name it', () => {
		expect(shipFacts(snapshot, 'billing')).toEqual({
			machine: 'atlas',
			reachable: true,
			presence: 'hosted',
			openTasks: 3,
			jobs: [
				{
					id: 'j1',
					task_id: null,
					task_title: 'Retries',
					doing_now: 'Replaying',
					started_ms: null,
					heavy: false,
					waits: null
				}
			],
			needs: 2
		});
	});

	it('says which machine is not reachable', () => {
		expect(shipFacts(snapshot, 'mobile-app')?.reachable).toBe(false);
	});

	it('is null for a ship the fleet does not place', () => {
		expect(shipFacts(snapshot, 'ghost')).toBeNull();
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
