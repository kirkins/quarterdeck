export interface ScryptParams {
	N: number;
	r: number;
	p: number;
}

export interface LoginHash extends ScryptParams {
	salt: Buffer;
	hash: Buffer;
}

export const SCRYPT_DEFAULTS: Readonly<ScryptParams>;

export const MIN_PASSPHRASE: number;

export function parseLoginHash(
	value: string | undefined
): { ok: true; value: LoginHash } | { ok: false; error: string };

export function hashPassphrase(passphrase: string, params?: ScryptParams): Promise<string>;

export function verifyPassphrase(passphrase: string, secret: LoginHash): Promise<boolean>;
