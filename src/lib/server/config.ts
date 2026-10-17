/**
 * Runtime configuration, read from the environment when the server starts.
 * Nothing fleet-specific is hard-coded; see README for the variables.
 */
export type SourceMode = 'fixtures' | 'cli';

export interface Config {
	source: SourceMode;
	/** Path to the privateer binary (PRIVATEER_BIN). Required for QD_SOURCE=cli. */
	privateerBin: string;
	/** Privateer home directory (PRIVATEER_HOME). Required for QD_SOURCE=cli. */
	privateerHome: string;
	/** QD_ALLOW_SEND=1 lets the cli source really send answers. Off by default. */
	allowSend: boolean;
	/** Where FixtureSource reads JSON from (QD_FIXTURES_DIR, default ./fixtures). */
	fixturesDir: string;
}

export function readConfig(env: Record<string, string | undefined> = process.env): Config {
	const source = (env.QD_SOURCE ?? 'fixtures').trim().toLowerCase();
	if (source !== 'fixtures' && source !== 'cli') {
		throw new Error(`QD_SOURCE must be "fixtures" or "cli", not "${env.QD_SOURCE}"`);
	}
	return {
		source,
		privateerBin: env.PRIVATEER_BIN ?? '',
		privateerHome: env.PRIVATEER_HOME ?? '',
		allowSend: env.QD_ALLOW_SEND === '1',
		fixturesDir: env.QD_FIXTURES_DIR || 'fixtures'
	};
}
