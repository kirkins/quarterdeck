# Quarterdeck

A web portal for a [Privateer](https://github.com/kirkins/privateer) fleet: where the captain sees what every ship needs and decides.

- **Decisions**: one card per thing the captain must decide, with options, costs and the ship's recommendation.
- **Triage** (soon): everything owed to the captain, sorted by urgency and age.
- **Fleet map** (soon): machines, ships and crew, live.

Quarterdeck reads Privateer only through its JSON commands, and answers as the captain. It must never be reachable without authentication.

Status: early development. Decisions are live; Triage and Fleet are placeholders.

| Phone, light                                      | Phone, dark                                     | Desktop                                               |
| ------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| ![Phone, light](docs/screenshots/phone-light.png) | ![Phone, dark](docs/screenshots/phone-dark.png) | ![Desktop, light](docs/screenshots/desktop-light.png) |

## Security

> [!WARNING]
> Quarterdeck acts as the captain: anyone who can load it can answer for you. Version 0 has **no authentication**. It listens on `127.0.0.1` by default and must sit behind an authenticating reverse proxy before it is exposed beyond the local machine in any way (LAN, tunnel or public host).

- `HOST` changes the listen address. Leave it at loopback unless an authenticating proxy is in front.
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

### Configuration

All settings come from the environment (see [.env.example](.env.example)). `npm start` also reads a `.env` file if there is one.

| Variable                          | Default     | Meaning                                                                              |
| --------------------------------- | ----------- | ------------------------------------------------------------------------------------ |
| `QD_SOURCE`                       | `fixtures`  | `fixtures` reads JSON from `fixtures/`; `cli` asks a live Privateer home.            |
| `PRIVATEER_BIN`, `PRIVATEER_HOME` |             | The privateer binary and home, for `QD_SOURCE=cli`.                                  |
| `QD_ALLOW_SEND`                   | off         | Exactly `1` to really send answers from the `cli` source. Otherwise they are logged. |
| `QD_FIXTURES_DIR`                 | `fixtures`  | Where the fixture source reads `captain.waiting.json` and `runtime.needs.json`.      |
| `HOST`, `PORT`                    | `127.0.0.1` | Listen address. `PORT` defaults to 3000 for `npm start`, 5173 for `npm run dev`.     |

The live source runs `captain.waiting` and `runtime.needs`, which are operator commands: the process needs operator rights on that home.

## How answering works

Each card shows the question, why it matters, who is blocked, the options (what happens, cost, and the ship's recommendation, marked but never preselected), the deadline and the asking ship. Answering is two deliberate steps: pick an option, or choose **Write my own answer** and say it in your own words (always available, whatever the ship asked for). Add a note under a chosen option if you want, then press **Send answer**. **Cancel** or Escape backs out.

The answer is a captain `mail.send`:

```json
{
	"from": "captain",
	"to": "<asking ship>",
	"kind": "reply",
	"correlation": "<decision mail id>",
	"body": "<chosen label> — <note>",
	"payload": { "answer": { "option_id": "<id>", "text": "<note>" } },
	"task_id": "<task of the ask, if any>"
}
```

`text` alone is always accepted: the captain can answer any decision in their own words. `free_text_ok` on a decision is only a hint that the ship especially invites one. `task_id` is included only when the ask has one. Older asks that only carry `payload.choices` are shown as simpler cards and answered with `payload.answer.text`.

In fixture mode, or without `QD_ALLOW_SEND=1`, the server logs the exact `mail.send` arguments and argv instead of running them, and marks the card answered in memory.

## Develop

```sh
npm run lint           # prettier + eslint
npm run check          # svelte-check
npm test               # vitest: schema, data layer, fixtures
npm run test:e2e       # Playwright smoke test (chromium) against a production build
npm run screenshots    # refresh docs/screenshots
```

Layout:

- `src/lib/decision.ts`: the decision schema, its validator, and mail → card normalisation.
- `src/lib/server/privateer.ts`: the CLI runner (`execFile`, argv only) and typed errors.
- `src/lib/server/source.ts`: `CliSource`, `FixtureSource`, and the send-or-log rule.
- `src/lib/server/answer.ts`: builds the reply from the captain's choice.
- `src/routes/+page.server.ts`: loads cards; the `answer` form action.
- `fixtures/`: invented ships and asks covering every card variant.

Why the stack looks the way it does: [docs/DECISIONS.md](docs/DECISIONS.md).

## License

MIT
