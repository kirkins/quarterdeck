/** Keep the shipped fixtures honest: valid, complete, and free of anything real. */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildCards, validateDecision, type MailItem } from '#lib/decision.ts';
import { FIXTURE_FILES, FixtureSource } from './source.ts';

const NOW = Date.now();

async function items(): Promise<MailItem[]> {
	return new FixtureSource('fixtures', () => NOW).waiting();
}

describe('fixtures', () => {
	it('every decision payload validates', async () => {
		for (const item of await items()) {
			const decision = (item.payload as { decision?: unknown } | null)?.decision;
			if (decision === undefined) continue;
			const result = validateDecision(decision);
			expect(result.ok ? [] : result.errors, item.id).toEqual([]);
		}
	});

	it('cover the cases the cards must handle', async () => {
		const all = await items();
		const cards = buildCards(all, NOW);
		const questions = cards.flatMap((c) => c.questions);
		const decisions = questions.filter((q) => q.kind === 'decision');

		expect(decisions.length).toBeGreaterThanOrEqual(5);
		expect(decisions.some((q) => q.options.some((o) => o.recommended && o.cost))).toBe(true);
		expect(decisions.some((q) => q.options.every((o) => !o.recommended))).toBe(true);
		expect(decisions.some((q) => q.free_text_ok)).toBe(true);
		expect(cards.some((c) => c.group && c.questions.length === 3)).toBe(true);
		expect(questions.some((q) => q.deadline_ms !== null && q.deadline_ms < NOW)).toBe(true);
		expect(questions.some((q) => q.kind === 'legacy' && q.options.length >= 2)).toBe(true);
		expect(all.some((m) => m.request_kind === 'needs_hands' && m.hands_on)).toBe(true);
		// A plain request is in the fixtures but is not a decision.
		expect(all.some((m) => m.kind === 'request' && !questions.some((q) => q.id === m.id))).toBe(
			true
		);
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
