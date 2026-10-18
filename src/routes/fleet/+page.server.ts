import { buildFleet } from '#lib/fleet.ts';
import { getPortal } from '#lib/server/app.ts';
import { errorText } from '#lib/server/submit.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ depends }) => {
	// The page refreshes itself with invalidate('quarterdeck:fleet'); see +page.svelte.
	depends('quarterdeck:fleet');
	const now = Date.now();
	try {
		const read = await getPortal().source.snapshot();
		if (read.status === 'unsupported') return { now, view: null, unsupported: true, error: null };
		return { now, view: buildFleet(read.snapshot), unsupported: false, error: null };
	} catch (error) {
		console.error('[quarterdeck] could not load the fleet:', error);
		return { now, view: null, unsupported: false, error: errorText(error) };
	}
};
