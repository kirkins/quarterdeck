# Quarterdeck

A web portal for a [Privateer](https://github.com/kirkins/privateer) fleet: where the captain sees what every ship needs and decides.

- **Decisions**: one card per thing the captain must decide, with options, costs and the ship's recommendation.
- **Triage**: everything owed to the captain, in one list: decisions, requests, approvals and blocked items, sorted by urgency, then deadline, then age.
- **Fleet**: machines, ships and crew, with what each is doing. Read-only; refreshes every 15 s while visible.
- **Reports**: a ship's Markdown or HTML report, read in a sandboxed frame. Select a passage (or tap a paragraph on a phone) to comment; send every comment back to the ship as one reply.

Quarterdeck reads Privateer only through its JSON commands, and answers as the captain. It must never be reachable without authentication: it has a built-in passphrase login for that.

Status: early development. Decisions, Triage, Fleet and Reports are live. Fleet reads a provisional `fleet.snapshot` shape; see [docs/DECISIONS.md](docs/DECISIONS.md) section 13.

| Phone, light                                      | Phone, dark                                     | Desktop                                               |
| ------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| ![Phone, light](docs/screenshots/phone-light.png) | ![Phone, dark](docs/screenshots/phone-dark.png) | ![Desktop, light](docs/screenshots/desktop-light.png) |

## Security

> [!WARNING]
> Quarterdeck acts as the captain: anyone who can use it can answer for you. It listens on `127.0.0.1` by default, with no login, for local development. Before it listens anywhere else, set `QD_LOGIN_SECRET` (`npm run hash-password`), keep it on a firewalled VPN address, and only then turn sending on. [docs/DEPLOY.md](docs/DEPLOY.md) is the step-by-step guide for a server.

- **Login.** With `QD_LOGIN_SECRET` set to a scrypt hash of a passphrase, every page, form action and endpoint needs a session, except the login page itself. Sessions are held in server memory (12 hours at most, 2 hours idle; a restart signs out) and named by a random id in an `HttpOnly`, `SameSite=Strict` cookie. Wrong passphrases are rate limited per address and overall. One user, no second factor: see [docs/DECISIONS.md](docs/DECISIONS.md), section 18.
- `HOST` changes the listen address. Leave it at loopback unless a login is set and you are deploying behind a firewalled VPN address (see the guide), or an authenticating proxy is in front.
- **Startup guard.** The server refuses to start when `HOST` is not loopback **and** `QD_ALLOW_SEND=1` without a valid login hash, when `QD_LOGIN_SECRET` is set but is not a strong enough scrypt hash, when `HOST` is not loopback and `ORIGIN` is unset, and when `QD_ALLOW_SEND=1` with `QD_SOURCE=fixtures`. Refusal exits with status 78 and says why.
- **Origin and Host checks.** Every request that changes something must carry this site's `Origin`, whatever its content type. With a non-loopback `HOST`, requests whose `Host` header is not `HOST:PORT` or the `ORIGIN` host get 403.
- **Headers.** Pages send a Content-Security-Policy (scripts by nonce, no framing, no plugins), `X-Frame-Options: DENY`, `Referrer-Policy: same-origin` and `Cache-Control: no-store`.
- Privateer is called with `execFile` and an argv array, never through a shell.
- Answers are only logged, not sent, unless `QD_SOURCE=cli` **and** `QD_ALLOW_SEND=1`.

## Run it

Requires Node 26 and npm.

```sh
npm install
npm run dev            # http://127.0.0.1:5173, fixture data
```

Production build:

```sh
npm run build
npm start              # http://127.0.0.1:3000 (HOST and PORT to change)
```

To run it on a server, reachable only over a VPN, follow [docs/DEPLOY.md](docs/DEPLOY.md). It includes a systemd user unit template in `deploy/`.

### Configuration

All settings come from the environment (see [.env.example](.env.example)). `npm start` also reads a `.env` file if there is one.

| Variable                          | Default     | Meaning                                                                                                                            |
| --------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `QD_SOURCE`                       | `fixtures`  | `fixtures` reads JSON from `fixtures/`; `cli` asks a live Privateer home.                                                          |
| `PRIVATEER_BIN`, `PRIVATEER_HOME` |             | The privateer binary and home, for `QD_SOURCE=cli`.                                                                                |
| `QD_ALLOW_SEND`                   | off         | Exactly `1` to really send answers from the `cli` source. Otherwise they are logged.                                               |
| `QD_LOGIN_SECRET`                 |             | The login: a scrypt hash from `npm run hash-password`. Unset means no login (loopback only).                                       |
| `QD_SESSION_HOURS`                | `12`        | A session's absolute lifetime.                                                                                                     |
| `QD_SESSION_IDLE_MINUTES`         | `120`       | A session ends after this long without a visit.                                                                                    |
| `QD_FIXTURES_DIR`                 | `fixtures`  | Where the fixture source reads `captain.waiting.json` and `runtime.needs.json`.                                                    |
| `HOST`, `PORT`                    | `127.0.0.1` | Listen address. `PORT` defaults to 3000 for `npm start`, 5173 for `npm run dev`.                                                   |
| `ORIGIN`                          |             | The browser's address, `http://<host>:<port>`. Required when `HOST` is not loopback; `https://` makes the session cookie `Secure`. |

The live source runs `captain.waiting` and `runtime.needs`. `captain.waiting` is open to the captain and the captain's liaison; `runtime.needs` is an operator command. The process needs one of those rights on that home, or Privateer refuses both.

## How answering works

Each card shows the question, why it matters, who is blocked, the options (what happens, cost, and the ship's recommendation, marked but never preselected), the deadline and the asking ship. Answering is two deliberate steps: pick an option, or choose **Write my own answer** and say it in your own words (always available, whatever the ship asked for). Add a note under a chosen option if you want, then press **Send answer**. **Cancel** or Escape backs out.

The answer is a `captain.reply`, keyed by the ask's item id. Privateer finds the ask and its ship; Quarterdeck sends no `from`, `to`, `correlation` or `task_id`:

```json
{
	"id": "<item id of the ask>",
	"body": "<chosen label> — <note>",
	"payload": { "answer": { "option_id": "<id>", "text": "<note>" } }
}
```

`text` alone is always accepted: the captain can answer any decision in their own words. `free_text_ok` on a decision is only a hint that the ship especially invites one. Older asks that only carry `payload.choices` are shown as simpler cards and answered with `payload.answer.text`.

Dismissing an ask is `captain.dismiss {id, note?}`. Live answering stays off until Privateer's `captain.reply` and `captain.dismiss` land.

In fixture mode, or without `QD_ALLOW_SEND=1`, the server logs the exact `captain.reply` or `captain.dismiss` arguments and argv instead of running them, and marks the card answered in memory.

## Develop

```sh
npm run lint           # prettier + eslint
npm run check          # svelte-check
npm test               # vitest: schema, data layer, fixtures
npm run test:e2e       # Playwright smoke test (chromium) against a production build, and the login on a second server
npm run hash-password  # print a QD_LOGIN_SECRET for a passphrase
npm run screenshots    # refresh docs/screenshots
```

Layout:

- `src/lib/decision.ts`: the decision schema, its validator, and mail → card normalisation.
- `src/lib/server/privateer.ts`: the CLI runner (`execFile`, argv only) and typed errors.
- `src/lib/server/source.ts`: `CliSource`, `FixtureSource`, and the send-or-log rule.
- `src/lib/shapes.ts`: reads the real `captain.waiting` and `runtime.needs` output into one item model.
- `src/lib/triage.ts`: triage kinds, sections, sort order and filters.
- `src/lib/fleet.ts`: the fleet map's summary, needs per ship, and machine and ship sort order.
- `src/lib/server/answer.ts`: builds the reply from the captain's choice.
- `startup-guard.js`: the startup checks (`server.js` runs them) and the Host check (`src/hooks.server.ts`).
- `login-hash.js`: the login secret's format, scrypt hashing and constant-time verification (`npm run hash-password` and the guard use it).
- `src/lib/server/auth.ts`: sessions, the login rate limiter and the `next` path check. `src/hooks.server.ts` requires a session on every route but `/login`.
- `src/routes/+page.server.ts`: loads cards; the `answer` form action.
- `fixtures/`: invented ships and asks covering every card variant.

Why the stack looks the way it does: [docs/DECISIONS.md](docs/DECISIONS.md).

## License

MIT
