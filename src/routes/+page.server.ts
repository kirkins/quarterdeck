import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** The landing page is the Feed. Decisions live at /decisions. */
export const load: PageServerLoad = () => {
	redirect(307, '/feed');
};
