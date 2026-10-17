// Production entry: `npm start` after `npm run build`.
// adapter-node listens on 0.0.0.0 by default; Quarterdeck acts as the captain,
// so default to loopback. Set HOST to change it (and put an authenticating
// proxy in front first; see README).
process.env.HOST ||= '127.0.0.1';
await import('./build/index.js');
