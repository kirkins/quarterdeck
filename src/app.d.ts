// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	namespace App {
		interface Locals {
			theme: 'light' | 'dark' | 'system';
			/** `off` when no QD_LOGIN_SECRET is set (loopback development only). */
			auth: 'off' | 'signed-in' | 'signed-out';
		}
	}
}

export {};
