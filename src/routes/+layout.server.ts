import { getPortal } from '#lib/server/app.ts';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
	const { config } = getPortal();
	return {
		theme: locals.theme,
		mode: config.source,
		/** True only when answers really go out: live source and QD_ALLOW_SEND=1. */
		live: config.source === 'cli' && config.allowSend
	};
};
