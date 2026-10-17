/**
 * Runs the privateer CLI. Always execFile with an argv array, never a shell:
 *
 *   [bin, "--home", home, command, "--json", JSON.stringify(args)]
 *
 * The binary and home come from configuration (PRIVATEER_BIN, PRIVATEER_HOME);
 * nothing fleet-specific lives in code.
 */
import { execFile as nodeExecFile } from 'node:child_process';

export interface PrivateerConfig {
	bin: string;
	home: string;
	/** Kill the CLI if it runs longer than this. Default 15s. */
	timeoutMs?: number;
}

/** The subset of child_process.execFile that we use; injectable for tests. */
export type ExecFile = (
	file: string,
	args: readonly string[],
	options: { timeout: number; maxBuffer: number; shell: false; encoding: 'utf8' },
	callback: (error: (Error & { code?: unknown }) | null, stdout: string, stderr: string) => void
) => unknown;

/** Base class: anything that went wrong talking to privateer. */
export class PrivateerError extends Error {
	readonly command: string;
	constructor(command: string, message: string) {
		super(message);
		this.name = 'PrivateerError';
		this.command = command;
	}
}

/** The CLI could not be run, timed out, or exited non-zero without a JSON error. */
export class PrivateerExecError extends PrivateerError {
	readonly stderr: string;
	constructor(command: string, message: string, stderr = '') {
		super(command, message);
		this.name = 'PrivateerExecError';
		this.stderr = stderr;
	}
}

/** The CLI printed something that is not a JSON object. */
export class PrivateerParseError extends PrivateerError {
	readonly output: string;
	constructor(command: string, output: string) {
		super(command, `privateer ${command} returned output that is not a JSON object`);
		this.name = 'PrivateerParseError';
		this.output = output;
	}
}

/** The CLI answered {"ok": false, "error": ...}. */
export class PrivateerCommandError extends PrivateerError {
	readonly error: unknown;
	constructor(command: string, error: unknown) {
		const detail = typeof error === 'string' ? error : JSON.stringify(error);
		super(command, `privateer ${command} failed: ${detail}`);
		this.name = 'PrivateerCommandError';
		this.error = error;
	}
}

/** The exact argv for a command. Exported so dry runs can log what would run. */
export function privateerArgv(
	config: Pick<PrivateerConfig, 'bin' | 'home'>,
	command: string,
	args: Record<string, unknown>
): [string, ...string[]] {
	return [config.bin, '--home', config.home, command, '--json', JSON.stringify(args)];
}

function parseOutput(command: string, stdout: string): Record<string, unknown> | null {
	const text = stdout.trim();
	if (text === '') return null;
	try {
		const value: unknown = JSON.parse(text);
		if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
			return value as Record<string, unknown>;
		}
	} catch {
		// fall through
	}
	throw new PrivateerParseError(command, text.slice(0, 2000));
}

export type Runner = <T = Record<string, unknown>>(
	command: string,
	args?: Record<string, unknown>
) => Promise<T>;

/** Make a runner bound to one binary and home. */
export function createRunner(config: PrivateerConfig, execFile: ExecFile = nodeExecFile): Runner {
	if (!config.bin) throw new Error('PRIVATEER_BIN is not set');
	if (!config.home) throw new Error('PRIVATEER_HOME is not set');
	const timeout = config.timeoutMs ?? 15_000;

	return <T>(command: string, args: Record<string, unknown> = {}) =>
		new Promise<T>((resolve, reject) => {
			const [file, ...argv] = privateerArgv(config, command, args);
			execFile(
				file,
				argv,
				{ timeout, maxBuffer: 16 * 1024 * 1024, shell: false, encoding: 'utf8' },
				(error, stdout, stderr) => {
					// privateer reports command failures as JSON on stdout, sometimes with a
					// non-zero exit; prefer that over the bare exit status.
					let parsed: Record<string, unknown> | null;
					try {
						parsed = parseOutput(command, stdout ?? '');
					} catch (parseError) {
						if (error) {
							reject(new PrivateerExecError(command, describeExecError(command, error), stderr));
						} else {
							reject(parseError);
						}
						return;
					}
					if (parsed && parsed.ok === false) {
						reject(new PrivateerCommandError(command, parsed.error ?? 'unknown error'));
						return;
					}
					if (error) {
						reject(new PrivateerExecError(command, describeExecError(command, error), stderr));
						return;
					}
					if (!parsed) {
						reject(new PrivateerParseError(command, ''));
						return;
					}
					resolve(parsed as T);
				}
			);
		});
}

function describeExecError(command: string, error: Error & { code?: unknown }): string {
	if (error.code === 'ENOENT') return `privateer binary not found (check PRIVATEER_BIN)`;
	if ((error as { killed?: boolean }).killed) return `privateer ${command} timed out`;
	// error.message repeats the whole command line; report the exit code instead.
	const code = typeof error.code === 'number' ? ` with exit code ${error.code}` : '';
	return `privateer ${command} failed${code}`;
}
