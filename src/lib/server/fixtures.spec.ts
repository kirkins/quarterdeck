/** Keep the shipped fixtures honest: valid, complete, and free of anything real. */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildCards, validateDecision } from '#lib/decision.ts';
import { groupSections, buildTriage, triageKind } from '#lib/triage.ts';
import { FIXTURE_FILES, FixtureSource } from './source.ts';

const NOW = Date.now();

async function items() {
	return (await new FixtureSource('fixtures', () => NOW).waiting()).items;
}

describe('fixtures', () => {
	it('every decision payload validates', async () => {
		for (const item of await items()) {
			const decision = (item.payload as { decision?: unknown } | null)?.decision;
			if (decision === undefined) continue;
			const result = validateDecision(decision);
			if (item.id === 'f0010-ranking-invalid') {
				// Deliberately malformed: shown from its body, not dropped.
				expect(result.ok).toBe(false);
				continue;
			}
			expect(result.ok ? [] : result.errors, item.id).toEqual([]);
		}
	});

	it('cover the cases the cards and triage must handle', async () => {
		const all = await items();
		const cards = buildCards(all, NOW);
		const questions = cards.flatMap((c) => c.questions);
		const decisions = questions.filter((q) => q.kind === 'decision');

		expect(decisions.length).toBeGreaterThanOrEqual(5);
		expect(decisions.some((q) => q.options.some((o) => o.recommended && o.cost))).toBe(true);
		expect(decisions.some((q) => q.options.every((o) => !o.recommended))).toBe(true);
		expect(cards.some((c) => c.group && c.questions.length >= 2)).toBe(true);
		expect(questions.some((q) => q.kind === 'invalid')).toBe(true);
		expect(questions.some((q) => q.deadline_ms !== null && q.deadline_ms < NOW)).toBe(true);
		expect(questions.some((q) => q.kind === 'legacy' && q.options.length >= 2)).toBe(true);
		expect(
			all.some((m) => (m.payload as { needs_hands?: unknown } | null)?.needs_hands && m.hands_on)
		).toBe(true);
		// A plain request is in the fixtures but is not a decision.
		expect(all.some((m) => m.kind === 'request' && !questions.some((q) => q.id === m.id))).toBe(
			true
		);
	});

	it('cover every triage kind, both urgencies, overdue, and every section', async () => {
		const rows = buildTriage(await items(), NOW).rows;
		const kinds = new Set(rows.map((r) => triageKind(r.item)));
		expect(kinds).toEqual(new Set(['decision', 'request', 'approval', 'notice', 'blocker']));
		expect(rows.filter((r) => r.urgency === 'high').length).toBeGreaterThanOrEqual(2);
		expect(rows.filter((r) => r.overdue).length).toBeGreaterThanOrEqual(2);
		expect(rows.some((r) => r.needsHands)).toBe(true);
		expect(groupSections(rows).map((s) => s.id)).toEqual(['now', 'waiting', 'later']);
		expect(rows.length).toBeGreaterThanOrEqual(15);
	});

	it('contain no hostnames, addresses, URLs or emails', async () => {
		for (const file of FIXTURE_FILES) {
			const text = await readFile(`fixtures/${file}`, 'utf8');
			expect(text, file).not.toMatch(/https?:\/\//);
			expect(text, file).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
			expect(text, file).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
			expect(text, file).not.toMatch(/\/home\/|\/Users\//);
			expect(text, file).not.toMatch(/\b[\w-]+\.(com|net|org|io|dev|local|lan|internal)\b/);
		}
	});
});
