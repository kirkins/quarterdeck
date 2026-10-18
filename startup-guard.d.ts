export interface StartupReport {
	ok: boolean;
	errors: string[];
	warnings: string[];
	summary: string;
}

export function isLoopback(host: string): boolean;

export function checkStartup(env?: Record<string, string | undefined>): StartupReport;

export function hostAllowed(
	env: Record<string, string | undefined>,
	hostHeader: string | null
): boolean;
