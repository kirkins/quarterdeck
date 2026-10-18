// `npm run hash-password`: read a passphrase and print the QD_LOGIN_SECRET
// line for it. On a terminal the passphrase is typed twice and never echoed;
// piped in, the first line is read. Only the hash is printed.
import { stdin, stderr, stdout } from 'node:process';
import { hashPassphrase, MIN_PASSPHRASE } from '../login-hash.js';

/**
 * Read one line from a terminal without echoing it.
 * @param {string} prompt
 * @returns {Promise<string>}
 */
function readHidden(prompt) {
	return new Promise((resolve, reject) => {
		stderr.write(prompt);
		stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding('utf8');
		let value = '';
		/** @param {string} chunk */
		const onData = (chunk) => {
			for (const char of chunk) {
				if (char === '\r' || char === '\n') {
					done();
					resolve(value);
					return;
				}
				if (char === '\u0003' || char === '\u0004') {
					done();
					reject(new Error('cancelled'));
					return;
				}
				if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
				else if (char >= ' ') value += char;
			}
		};
		const done = () => {
			stdin.off('data', onData);
			stdin.setRawMode(false);
			stdin.pause();
			stderr.write('\n');
		};
		stdin.on('data', onData);
	});
}

/** The first line of a piped stdin. */
async function readPiped() {
	let text = '';
	stdin.setEncoding('utf8');
	for await (const chunk of stdin) text += chunk;
	return text.split(/\r?\n/)[0];
}

async function main() {
	let passphrase;
	if (stdin.isTTY) {
		passphrase = await readHidden('Passphrase: ');
		const again = await readHidden('Again: ');
		if (again !== passphrase) throw new Error('the two passphrases differ');
	} else {
		passphrase = await readPiped();
	}
	if ([...passphrase].length < MIN_PASSPHRASE) {
		throw new Error(`use at least ${MIN_PASSPHRASE} characters; a few unrelated words is best`);
	}
	stdout.write(`${await hashPassphrase(passphrase)}\n`);
	stderr.write('Put this line in QD_LOGIN_SECRET. It is a hash, not the passphrase.\n');
}

main().catch((error) => {
	stderr.write(`hash-password: ${error instanceof Error ? error.message : error}\n`);
	process.exit(1);
});
