// The login secret: a scrypt hash of the captain's passphrase, never the
// passphrase itself. Plain JS so that the startup guard and
// `npm run hash-password` can use it without a build; the types are in
// login-hash.d.ts. Nothing here logs or returns a passphrase or a hash.
//
// Format: scrypt$<N>$<r>$<p>$<salt>$<hash>, salt and hash in unpadded base64url.

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** What `npm run hash-password` writes, and the weakest the server accepts. */
export const SCRYPT_DEFAULTS = Object.freeze({ N: 2 ** 17, r: 8, p: 1 });

const LIMITS = Object.freeze({
	minN: 2 ** 17,
	maxN: 2 ** 20,
	minR: 8,
	maxR: 32,
	minP: 1,
	maxP: 16,
	minSalt: 16,
	minHash: 32,
	maxHash: 64,
	// Each verify holds 128 * N * r bytes; refuse a hash that would ask for more.
	maxMemory: 1024 * 1024 * 1024
});

/** The shortest passphrase `npm run hash-password` accepts. */
export const MIN_PASSPHRASE = 12;

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const DIGITS = /^[1-9][0-9]{0,9}$/;

/** @param {number} N @param {number} r */
function memoryFor(N, r) {
	return 128 * N * r;
}

/**
 * Read a QD_LOGIN_SECRET. The error names what is wrong, never the value.
 * @param {string | undefined} value
 * @returns {{ ok: true, value: import('./login-hash.js').LoginHash } | { ok: false, error: string }}
 */
export function parseLoginHash(value) {
	const parts = (value ?? '').trim().split('$');
	if (parts.length !== 6 || parts[0] !== 'scrypt') {
		return {
			ok: false,
			error:
				'QD_LOGIN_SECRET is not a scrypt hash (scrypt$N$r$p$salt$hash). ' +
				'Make one with `npm run hash-password`; never put the passphrase itself here.'
		};
	}
	const [, n, r, p, salt, hash] = parts;
	if (!DIGITS.test(n) || !DIGITS.test(r) || !DIGITS.test(p)) {
		return { ok: false, error: 'QD_LOGIN_SECRET has a malformed N, r or p.' };
	}
	const params = { N: Number(n), r: Number(r), p: Number(p) };
	if ((params.N & (params.N - 1)) !== 0) {
		return { ok: false, error: 'QD_LOGIN_SECRET has an N that is not a power of two.' };
	}
	if (params.N < LIMITS.minN || params.r < LIMITS.minR || params.p < LIMITS.minP) {
		return {
			ok: false,
			error:
				`QD_LOGIN_SECRET uses weak scrypt parameters: N, r and p must be at least ` +
				`${LIMITS.minN}, ${LIMITS.minR} and ${LIMITS.minP}. Make a new one with \`npm run hash-password\`.`
		};
	}
	if (
		params.N > LIMITS.maxN ||
		params.r > LIMITS.maxR ||
		params.p > LIMITS.maxP ||
		memoryFor(params.N, params.r) > LIMITS.maxMemory
	) {
		return {
			ok: false,
			error: 'QD_LOGIN_SECRET asks for more scrypt work than the server allows per login.'
		};
	}
	if (!BASE64URL.test(salt) || !BASE64URL.test(hash)) {
		return { ok: false, error: 'QD_LOGIN_SECRET has a salt or hash that is not base64url.' };
	}
	const saltBytes = Buffer.from(salt, 'base64url');
	const hashBytes = Buffer.from(hash, 'base64url');
	if (saltBytes.length < LIMITS.minSalt) {
		return { ok: false, error: `QD_LOGIN_SECRET has a salt shorter than ${LIMITS.minSalt} bytes.` };
	}
	if (hashBytes.length < LIMITS.minHash || hashBytes.length > LIMITS.maxHash) {
		return {
			ok: false,
			error: `QD_LOGIN_SECRET has a hash that is not ${LIMITS.minHash} to ${LIMITS.maxHash} bytes.`
		};
	}
	return { ok: true, value: { ...params, salt: saltBytes, hash: hashBytes } };
}

/**
 * @param {string} passphrase
 * @param {Buffer} salt
 * @param {number} length
 * @param {{ N: number, r: number, p: number }} params
 * @returns {Promise<Buffer>}
 */
function derive(passphrase, salt, length, { N, r, p }) {
	return new Promise((resolve, reject) => {
		scrypt(
			passphrase.normalize('NFC'),
			salt,
			length,
			{ N, r, p, maxmem: memoryFor(N, r) + 32 * 1024 * 1024 },
			(error, key) => (error ? reject(error) : resolve(key))
		);
	});
}

/**
 * A new QD_LOGIN_SECRET line for a passphrase, with a fresh random salt.
 * @param {string} passphrase
 * @param {{ N: number, r: number, p: number }} [params]
 */
export async function hashPassphrase(passphrase, params = SCRYPT_DEFAULTS) {
	const salt = randomBytes(16);
	const hash = await derive(passphrase, salt, 32, params);
	return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

/**
 * Whether a passphrase matches. The comparison is constant-time; the scrypt
 * work is the same whatever the passphrase.
 * @param {string} passphrase
 * @param {import('./login-hash.js').LoginHash} secret
 */
export async function verifyPassphrase(passphrase, secret) {
	const key = await derive(passphrase, secret.salt, secret.hash.length, secret);
	return timingSafeEqual(key, secret.hash);
}
