/**
 * The running portal's state: configuration, the decision source, and the
 * answers given since the server started. Created on first use so that
 * building the app never reads the environment or touches privateer.
 */
import type { Answered } from '#lib/decision.ts';
import { readConfig, type Config } from './config.ts';
import { createSource, type Source } from './source.ts';

export interface Portal {
	config: Config;
	source: Source;
	/**
	 * Answers given in this process, by asking mail id. In dry runs this is the
	 * only record that a card was answered; with live sending it also hides
	 * the brief window before captain.waiting stops listing the ask.
	 */
	answers: Map<string, Answered>;
}

let portal: Portal | undefined;

export function getPortal(): Portal {
	if (!portal) {
		const config = readConfig();
		portal = { config, source: createSource(config), answers: new Map() };
	}
	return portal;
}
