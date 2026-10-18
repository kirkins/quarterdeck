import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';

// The portal acts as the captain: listen on loopback unless HOST says otherwise.
const host = process.env.HOST || '127.0.0.1';

// A report's frame is a srcdoc, which inherits this CSP as well as its own, so
// the annotator it runs is allowed here by its hash (src/lib/server/render.ts).
const annotator = readFileSync(new URL('./src/lib/server/annotator.txt', import.meta.url), 'utf8');
const annotatorHash = `sha256-${createHash('sha256').update(annotator).digest('base64')}` as const;

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			// SvelteKit adds a nonce for its own inline scripts. Styles allow inline
			// because Svelte writes style attributes; scripts never do.
			csp: {
				mode: 'nonce',
				directives: {
					'default-src': ['self'],
					'script-src': ['self', annotatorHash],
					'style-src': ['self', 'unsafe-inline'],
					'img-src': ['self', 'data:'],
					'font-src': ['self'],
					'connect-src': ['self'],
					'frame-src': ['self'],
					'object-src': ['none'],
					'base-uri': ['none'],
					'form-action': ['self'],
					'frame-ancestors': ['none']
				}
			}
		})
	],
	server: { host, port: 5173, strictPort: true },
	preview: { host, port: 4173, strictPort: true },
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
