# Deploying Quarterdeck

This guide runs Quarterdeck on a server you control, reachable only over a private network (for example a WireGuard VPN) from your own devices. It is written for the first run: live Privateer data, read-only.

Read this first. Quarterdeck acts as the captain. Anyone who can use the portal can answer for you. Three things keep it safe, and you need all three:

- **The login.** Set `QD_LOGIN_SECRET` to a hash of a passphrase only you know (step 4). Every page, form and endpoint then needs a session. The startup guard refuses `QD_ALLOW_SEND=1` on a non-loopback bind until a valid hash is set.
- **Bind `HOST` to the VPN address only**, never `0.0.0.0` and never a public address, and set `ORIGIN` to the address the browser uses. The guard refuses a non-loopback `HOST` without `ORIGIN`.
- **Firewall the port** so that only your own devices can reach it. A VPN address is not a firewall.

Turn sending on last: first sign in and check the login works, with `QD_ALLOW_SEND=0`; only then set `QD_ALLOW_SEND=1` (step 5).

Placeholders such as `<vpn-address>`, `<install-dir>` and `<privateer-home>` stand for your own values. Do not commit them.

## 1. Prerequisites

- **Node.js 26** and npm. The project declares `"engines": { "node": ">=26" }` and sets `engine-strict`, so `npm ci` refuses any other version. CI tests Node 26 only. The dependencies' own floors are lower (SvelteKit needs Node 22.17 or later), so an older Node may work, but that has not been tested.
- **Privateer** installed and working for the account that runs Quarterdeck. Note the path to its binary and its home directory (`<privateer-home>`).
- A **WireGuard** (or similar) VPN between the server and your devices, with the server's VPN address `<vpn-address>`.
- Git, to clone the repository. No C/C++ toolchain is needed: the dependencies are pure JavaScript.

## 2. Get the code

```sh
git clone <repo-url> <install-dir>
cd <install-dir>
git checkout <release-tag-or-main>
```

## 3. Install and build

```sh
npm ci
npm run build
```

`npm ci` installs exactly what `package-lock.json` records. `npm run build` writes the server to `build/`.

## 4. Configure

```sh
cp .env.example .env
chmod 600 .env
```

### Make the login hash

Choose a passphrase: a few unrelated words, at least 12 characters, used nowhere else. Then, on the server:

```sh
npm run hash-password
```

It asks for the passphrase twice without echoing it, and prints one line:

```
scrypt$131072$8$1$<salt>$<hash>
```

That line is a scrypt hash with a random salt, not the passphrase: the server never stores or sees the passphrase except while checking a login. Still, keep it private (`.env` is `chmod 600`), since anyone with it can try guesses offline. Run it again to change the passphrase; the old hash stops working on the next restart. The server refuses a hash with weaker scrypt settings than these.

### Set the variables

Edit `.env`. Every variable is documented in `.env.example` and in the [README](../README.md#configuration). For the first run, set:

```sh
QD_SOURCE=cli
PRIVATEER_BIN=<privateer-bin>          # the privateer binary, e.g. from `command -v privateer`
PRIVATEER_HOME=<privateer-home>
QD_ALLOW_SEND=0                         # on only after the login is tested (step 5)
QD_LOGIN_SECRET='scrypt$131072$8$1$<salt>$<hash>'   # the line from npm run hash-password
HOST=<vpn-address>
PORT=3000
ORIGIN=http://<vpn-address>:3000
```

Keep the hash in single quotes. Neither `npm start` nor systemd expands the `$` signs in it either way, but the quotes keep it safe if you ever `source` the file in a shell.

| Variable                  | Required                         | What it does                                                                                                                                 |
| ------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `QD_SOURCE`               | yes                              | `cli` reads a live Privateer home. `fixtures` (the default) reads invented JSON, for a demo only.                                            |
| `PRIVATEER_BIN`           | with `cli`                       | The privateer binary. Run as an absolute path.                                                                                               |
| `PRIVATEER_HOME`          | with `cli`                       | The Privateer home directory the portal reads.                                                                                               |
| `QD_ALLOW_SEND`           | no (default `0`)                 | Exactly `1` to really send answers. Refused at startup with `fixtures`, and refused when `HOST` is not loopback unless a login is set.       |
| `QD_LOGIN_SECRET`         | yes, when `HOST` is not loopback | The scrypt hash from `npm run hash-password`. Turns the login on for every route. Not a hash, or weak settings: the server refuses to start. |
| `QD_SESSION_HOURS`        | no (default `12`)                | How long a session lasts after signing in, however busy.                                                                                     |
| `QD_SESSION_IDLE_MINUTES` | no (default `120`)               | A session ends after this long without a visit.                                                                                              |
| `QD_FIXTURES_DIR`         | no                               | Where the fixture source reads its JSON. Only used with `fixtures`.                                                                          |
| `HOST`                    | no (default `127.0.0.1`)         | The listen address. Set it to `<vpn-address>`, not `0.0.0.0`.                                                                                |
| `PORT`                    | no (default `3000`)              | The listen port. Firewall it (step 6).                                                                                                       |
| `ORIGIN`                  | yes, when `HOST` is not loopback | The address the browser uses, `http://<vpn-address>:<port>`. Every post from another origin is refused. Without it, startup refuses.         |

With a non-loopback `HOST`, Quarterdeck also refuses requests whose `Host` header is not `HOST:PORT` or the `ORIGIN` host. That blocks DNS rebinding from a web page on your device.

`npm start` loads `.env` itself. The systemd unit in step 5 loads it through `EnvironmentFile=` instead, so the two agree.

## 5. Run it

Try it in the foreground first:

```sh
npm start
```

You should see one line like this, and no secrets:

```
quarterdeck: source=cli send=off login=on listen=<vpn-address>:3000
```

`login=on` means the hash was read. If the guard refuses to start, it prints why and exits with status 78. Fix the setting it names. Common cases:

- `QD_LOGIN_SECRET is not a scrypt hash`: paste the whole line from `npm run hash-password`, not the passphrase.
- `QD_LOGIN_SECRET uses weak scrypt parameters`: make a new hash with `npm run hash-password`.
- `HOST=... is not loopback and ORIGIN is unset`: set `ORIGIN` to the address the browser uses.
- `HOST=... is not loopback and QD_ALLOW_SEND=1, but no login is configured`: set `QD_LOGIN_SECRET`, or `QD_ALLOW_SEND=0`.
- `QD_ALLOW_SEND=1 with QD_SOURCE=fixtures`: set `QD_SOURCE=cli`, or `QD_ALLOW_SEND=0`.
- `ORIGIN must be an http:// or https:// URL`: fix the `ORIGIN` value.

### Check the login, then turn sending on

From a device on the VPN, open `http://<vpn-address>:3000`. You should land on **Come aboard**, the login page, and nothing else should load without signing in. Then:

1. Type a wrong passphrase: the page says it did not work, and the server log shows `login failed at <time> from <address>` (never what was typed).
2. Sign in with the right one: you reach the Feed, and the sidebar (or the top bar on a phone) shows **Sign out**.
3. Sign out: you are back at the login page, and the Feed asks you to sign in again.

Only then set `QD_ALLOW_SEND=1` in `.env` and restart. The startup line says `send=on login=on`.

Stop it with Ctrl-C, then run it as a service.

### As a systemd user service

Copy the template and fill in the placeholders. `command -v node` prints the path for `<node-bin>`:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/quarterdeck.service ~/.config/systemd/user/quarterdeck.service
$EDITOR ~/.config/systemd/user/quarterdeck.service   # replace each <placeholder>
systemctl --user daemon-reload
systemctl --user enable --now quarterdeck
systemctl --user status quarterdeck
journalctl --user -u quarterdeck -f
```

The unit runs as your user, with your Privateer identity. It must not set `PRIVATEER_ACTOR` or `PRIVATEER_ROLE`: Quarterdeck answers as the captain, not as another actor.

To keep it running on a server with no login session, enable lingering once, as your user:

```sh
loginctl enable-linger "$USER"
```

The unit restarts on failure, but not when the guard refuses (status 78), so a bad setting does not loop.

## 6. Firewall the port

Only your own devices should reach the port, and only over the VPN. For example, with ufw and the VPN interface named `<vpn-interface>`:

```sh
sudo ufw allow in on <vpn-interface> to any port 3000 proto tcp
sudo ufw deny 3000/tcp
```

Check it from a device that is not on the VPN: the port must not answer. Then check it from one that is on the VPN: the page must load.

Do not expose the port on a public interface. The login is one passphrase with no second factor, built for a private network. If you ever want access without the VPN, put an authenticating reverse proxy (such as Authelia) in front first, with TLS, and keep `HOST` on loopback behind it.

## 7. Update

```sh
cd <install-dir>
git pull
npm ci
npm run build
systemctl --user restart quarterdeck
journalctl --user -u quarterdeck -n 5
```

Check the startup line after each restart. If the guard refuses, the new version needs a setting you do not have yet; the README and `.env.example` say what it is.

## About the login

- **One user, the captain.** One passphrase, no user names, no second factor.
- **Sessions live in the server's memory.** A restart (including `systemctl --user restart` after an update) signs every device out; sign in again. A session lasts `QD_SESSION_HOURS` (12) at most, and ends after `QD_SESSION_IDLE_MINUTES` (120) without a visit. Sign out ends it on the server, not just in the browser.
- **Guessing is slow.** Five wrong passphrases from one address in 15 minutes lock that address out for 15 minutes, then 30, 60 and so on up to a day; twenty from anywhere lock everyone out for up to 15 minutes. If you lock yourself out, wait, or restart the service.
- **Plain HTTP over the VPN.** WireGuard encrypts the traffic, so the cookie is not marked `Secure` on an `http://` origin. With an `https://` `ORIGIN` (behind a TLS proxy) it is.
- Why it is built this way: [DECISIONS.md](DECISIONS.md), section 18.

## What this does not do yet

- **No second factor** and no per-device sessions list. Put Authelia or another authenticating proxy in front if you need either.
- **Answers are not sent** unless `QD_ALLOW_SEND=1`, and that is refused on a non-loopback bind until a valid login hash is set.
- The Fleet and Spend views read provisional shapes; see [DECISIONS.md](DECISIONS.md).
