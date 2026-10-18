// Production entry: `npm start` after `npm run build`.
// adapter-node listens on 0.0.0.0 by default; Quarterdeck acts as the captain,
// so default to loopback. Set HOST to change it (and put an authenticating
// proxy in front first; see README).
import { checkStartup } from './startup-guard.js';

const report = checkStartup(process.env);
for (const warning of report.warnings) console.warn(`quarterdeck: warning: ${warning}`);
if (!report.ok) {
	for (const error of report.errors) console.error(`quarterdeck: refusing to start: ${error}`);
	// 78 is EX_CONFIG: the unit template does not restart on it.
	process.exit(78);
}
console.log(`quarterdeck: ${report.summary}`);

process.env.HOST ||= '127.0.0.1';
await import('./build/index.js');
