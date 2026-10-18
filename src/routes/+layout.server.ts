import { getPortal, loadItems } from '#lib/server/app.ts';
import { buildTriage } from '#lib/triage.ts';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	const { config, answers } = getPortal();
	// The nav badge. If Privateer cannot be read, the badge is simply absent.
	let triage: number | null;
	try {
		const { items } = await loadItems();
		triage = buildTriage(items, Date.now(), answers).rows.length;
	} catch {
		triage = null;
	}
	return {
		theme: locals.theme,
		mode: config.source,
		/** True only when answers really go out: live source and QD_ALLOW_SEND=1. */
		live: config.source === 'cli' && config.allowSend,
		triage
	};
};
