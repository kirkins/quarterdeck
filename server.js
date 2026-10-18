// Production entry: `npm start` after `npm run build`.
// adapter-node listens on 0.0.0.0 by default; Quarterdeck acts as the captain,
// so default to loopback. Set HOST to change it (and set QD_LOGIN_SECRET and
// ORIGIN first; see docs/DEPLOY.md).
import { checkStartup, requestOrigin } from './startup-guard.js';

const report = checkStartup(process.env);
for (const warning of report.warnings) console.warn(`quarterdeck: warning: ${warning}`);
if (!report.ok) {
	for (const error of report.errors) console.error(`quarterdeck: refusing to start: ${error}`);
	// 78 is EX_CONFIG: the unit template does not restart on it.
	process.exit(78);
}
console.log(`quarterdeck: ${report.summary}`);

process.env.HOST ||= '127.0.0.1';

// adapter-node reads the request's protocol and host from headers it is told
// to trust (see requestOrigin). These two are ours: set on every request below,
// before the app sees it, so a client cannot choose them.
const PROTOCOL = 'x-quarterdeck-protocol';
const HOST = 'x-quarterdeck-host';
const origin = requestOrigin(process.env);
process.env.PROTOCOL_HEADER = PROTOCOL;
if (origin.host) process.env.HOST_HEADER = HOST;
else delete process.env.HOST_HEADER;

const { server } = await import('./build/index.js');
server.prependListener('request', (/** @type {import('node:http').IncomingMessage} */ req) => {
	req.headers[PROTOCOL] = origin.protocol;
	if (origin.host) req.headers[HOST] = origin.host;
});
