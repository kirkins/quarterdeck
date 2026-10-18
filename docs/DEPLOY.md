# Deploying Quarterdeck

This guide runs Quarterdeck on a server you control, reachable only over a private network (for example a WireGuard VPN) from your own devices. It is written for the first run: live Privateer data, read-only.

Read this first. Quarterdeck acts as the captain. Anyone who can load the portal can answer for you. Version 0 has **no authentication**, so the rules below are what keeps it safe:

- **Bind `HOST` to the VPN address only**, never `0.0.0.0` and never a public address. The startup guard refuses to start when `HOST` is not loopback and sending is on without a login.
- **Firewall the port** so that only your own devices can reach it. A VPN address is not a firewall.
- **Keep `QD_ALLOW_SEND=0`** until a login is configured and tested. With it off, answers are logged and never sent to Privateer.
- A login (`QD_LOGIN_SECRET`) is not built yet. Until it is, the guard refuses `QD_ALLOW_SEND=1` on any non-loopback bind, whether or not `QD_LOGIN_SECRET` is set.

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

Edit `.env`. Every variable is documented in `.env.example` and in the [README](../README.md#configuration). For the first run, set:

```sh
QD_SOURCE=cli
PRIVATEER_BIN=<privateer-bin>          # the privateer binary, e.g. from `command -v privateer`
PRIVATEER_HOME=<privateer-home>
QD_ALLOW_SEND=0
QD_LOGIN_SECRET=                        # leave empty until a login exists
HOST=<vpn-address>
PORT=3000
ORIGIN=http://<vpn-address>:3000
```

| Variable          | Required                         | What it does                                                                                                                             |
| ----------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `QD_SOURCE`       | yes                              | `cli` reads a live Privateer home. `fixtures` (the default) reads invented JSON, for a demo only.                                        |
| `PRIVATEER_BIN`   | with `cli`                       | The privateer binary. Run as an absolute path.                                                                                           |
| `PRIVATEER_HOME`  | with `cli`                       | The Privateer home directory the portal reads.                                                                                           |
| `QD_ALLOW_SEND`   | no (default `0`)                 | Exactly `1` to really send answers. Refused at startup with `fixtures`, and refused when `HOST` is not loopback unless a login is set.   |
| `QD_LOGIN_SECRET` | no                               | Reserved for the coming login. Not enforced yet, so it does not count as a login: sending stays refused on a network bind.               |
| `QD_FIXTURES_DIR` | no                               | Where the fixture source reads its JSON. Only used with `fixtures`.                                                                      |
| `HOST`            | no (default `127.0.0.1`)         | The listen address. Set it to `<vpn-address>`, not `0.0.0.0`.                                                                            |
| `PORT`            | no (default `3000`)              | The listen port. Firewall it (step 6).                                                                                                   |
| `ORIGIN`          | yes, when `HOST` is not loopback | The address the browser uses, `http://<vpn-address>:<port>`. SvelteKit rejects form posts from other origins. Without it, startup warns. |

With a non-loopback `HOST`, Quarterdeck also refuses requests whose `Host` header is not `HOST:PORT` or the `ORIGIN` host. That blocks DNS rebinding from a web page on your device.

`npm start` loads `.env` itself. The systemd unit in step 5 loads it through `EnvironmentFile=` instead, so the two agree.

## 5. Run it

Try it in the foreground first:

```sh
npm start
```

You should see one line like this, and no secrets:

```
quarterdeck: source=cli send=off login=off listen=<vpn-address>:3000
```

If the guard refuses to start, it prints why and exits with status 78. Fix the setting it names. Common cases:

- `HOST=... is not loopback and QD_ALLOW_SEND=1, but no login is configured`: set `QD_ALLOW_SEND=0`.
- `QD_ALLOW_SEND=1 with QD_SOURCE=fixtures`: set `QD_SOURCE=cli`, or `QD_ALLOW_SEND=0`.
- `ORIGIN must be an http:// or https:// URL`: fix the `ORIGIN` value.

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

Do not expose the port on a public interface. If you ever want access without the VPN, put an authenticating reverse proxy in front first, and keep `HOST` on loopback behind it.

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

## What this does not do yet

- **No login.** Anyone who can reach the port acts as the captain. The VPN and the firewall are the only protection.
- **Answers are not sent** unless `QD_ALLOW_SEND=1`, and that is refused on a non-loopback bind until a login exists.
- The Fleet and Spend views read provisional shapes; see [DECISIONS.md](DECISIONS.md).
