# jtui

A terminal coding agent that uses **Google Cloud Vertex AI** as its model provider — every model
your project can call, including third-party ones. Gemini and Claude are both first-class; jtui
speaks each publisher's native API and routes per model.

Architecturally it follows [pi](https://github.com/earendil-works/pi): a layered monorepo where the
terminal UI, the model client, the agent runtime, and the CLI are separate packages. Unlike pi,
every request goes through Vertex AI with Application Default Credentials and is billed to your own
GCP project — there are no per-vendor API keys.

**Nothing about the model list is hardcoded.** jtui discovers what your project can call by querying
Vertex Model Garden, so a different account, project, or region shows a different list, and new
models appear without a jtui release.

```
❯ There is a bug in src/math.js. Find it and fix it.

● read 1ms
  1     export function add(a, b) {
  2       return a - b;
  3     }

● edit 2ms
  Edited src/math.js (1 replacement).

Fixed src/math.js:2 — add was subtracting instead of adding.
```

## Packages

| Package | Description |
|---|---|
| [`@jtui/tui`](packages/tui) | Terminal UI library with differential rendering |
| [`@jtui/ai`](packages/ai) | Vertex AI client: ADC auth, model discovery, per-publisher API adapters |
| [`@jtui/agent`](packages/agent) | Agent loop, tool execution, session persistence |
| [`@jtui/cli`](packages/cli) | The `jtui` command: tools, prompts, interactive and print modes |

Each layer depends only on the ones above it.

## Setup

Requires Node 22.19+ and a Google Cloud project with the Vertex AI API enabled.

```bash
npm install
npm run build

# One-time Google Cloud setup
gcloud auth application-default login
gcloud config set project YOUR_PROJECT_ID
gcloud services enable aiplatform.googleapis.com

./jtui-dev.sh auth      # verify credentials resolve
```

`jtui auth` prints the project, location, and where each came from — start there if anything fails.

## Usage

```bash
jtui                                  # interactive
jtui "fix the failing test"           # interactive, with a first prompt
jtui -p "explain src/server.ts"       # print the answer and exit
jtui -p --json "list the routes"      # one JSON event per line
jtui models                           # what this project can actually call
jtui models --all --refresh           # include other publishers, re-query
jtui -m claude-opus-4-5 "review this" # any discovered model
jtui sessions                         # transcripts saved in this directory
jtui -c                               # resume the most recent session
```

## Models

`jtui models` queries Vertex Model Garden for every publisher and reports what your project can
see:

```
Models for my-project in global

anthropic
  claude-opus-4-5
  claude-sonnet-4-5
google
  gemini-2.5-pro
  gemini-3.5-flash
```

The result is cached under `~/.jtui/catalog/` for a day; `--refresh` re-queries. jtui picks a
default from what is actually available, so it works on a fresh account without configuration.

**Being listed is not the same as having access.** Model Garden lists everything Google publishes;
calling a model additionally requires it to be enabled for your project, which is why a listed model
can still return 404. The error message says so and suggests the fix.

Switching model mid-session with `/model` is safe across publishers — reasoning blocks signed by one
provider are dropped rather than replayed to another, which would be rejected.

### Adding a publisher

`packages/ai/src/catalog.ts` maps publishers to API adapters. Publishers without an adapter are
still discovered and shown by `jtui models --all`, marked as uncallable. Adding one means writing an
adapter beside `api/gemini.ts` and `api/anthropic.ts` and registering it there.

Run from source during development with `./jtui-dev.sh` (same arguments).

### Options

| Flag | Meaning |
|---|---|
| `-p, --print` | Non-interactive; answer to stdout |
| `--json` | With `--print`, emit one JSON event per line |
| `-m, --model <id>` | Model id; any model from `jtui models` |
| `--project <id>` | Google Cloud project |
| `--location <region>` | Vertex location (default `us-central1`; `global` also works) |
| `--thinking <level>` | `off`, `low`, `medium`, `high` (default `medium`) |
| `--max-turns <n>` | Stop after n assistant turns |
| `--credentials <path>` | Service account key file |
| `-c, --continue` / `--resume <id>` | Resume a session |
| `--no-project-context` | Ignore `JTUI.md` / `AGENTS.md` / `CLAUDE.md` |
| `--refresh` | Re-query the model catalog instead of using the cache |
| `--all` | With `models`, include publishers jtui cannot call |

### Interactive keys

`enter` send · `shift+enter` newline (or end the line with `\`) · `esc` interrupt ·
`ctrl+c` clear input, twice to quit · `ctrl+d` quit · `up`/`down` history

Slash commands: `/help` `/model` `/models [refresh]` `/clear` `/cost` `/tools` `/cwd` `/exit`

## Authentication

jtui uses Application Default Credentials, resolved in this order:

1. `--credentials <path>` or `GOOGLE_APPLICATION_CREDENTIALS` (service account key)
2. `~/.config/gcloud/application_default_credentials.json` (from `gcloud auth application-default login`)
3. The metadata server, on GCE / Cloud Run / Cloud Build

The project is resolved from `--project`, then `GOOGLE_CLOUD_PROJECT`, then the credential file's
`quota_project_id`, then `gcloud config`. Location comes from `--location` or
`GOOGLE_CLOUD_LOCATION`, defaulting to `us-central1`.

Requests are billed to that project against your own Vertex AI rates and quota. jtui ships **no**
pricing data — rates vary by contract and publisher, and a stale table is worse than none — so cost
is reported as unknown unless you supply rates yourself (see Configuration).

## Configuration

Settings merge from `~/.jtui/config.json` then `.jtui/config.json` in the project, with CLI flags
on top:

```json
{
  "model": "claude-opus-4-5",
  "location": "global",
  "thinking": "high",
  "maxTurns": 30,
  "pricing": {
    "claude-opus-4-5": { "inputPerMillion": 5, "outputPerMillion": 25, "cachedInputPerMillion": 0.5 }
  }
}
```

`pricing` is optional and drives only the local cost estimate. Without it, `/cost` reports token
counts and says the cost is unknown.

Session transcripts are written to `.jtui/sessions/*.jsonl` as they happen, so an interrupted run
is still resumable.

## Project instructions

If `JTUI.md`, `AGENTS.md`, or `CLAUDE.md` is present (first match wins), its contents are appended
to the system prompt. Use it for project conventions the agent should follow.

## Tools

`read` `write` `edit` `list` `glob` `grep` `bash`

`bash` keeps its working directory between calls and runs each command in its own process group, so
a timeout or interrupt kills the whole command tree. `grep` uses ripgrep when it is installed and
falls back to a pure-Node scan.

There is no permission prompt: tools run with the privileges of the user who started jtui. Run it in
a container or VM if you need a real boundary.

## Development

```bash
npm install          # install dependencies
npm run build        # compile all packages to dist/
npm run check        # biome lint/format + tsc --noEmit
npm test             # vitest, no network or credentials needed
./jtui-dev.sh        # run from source
```

Tests use a stubbed model client throughout — no API keys, no billable calls.

To exercise the real TUI in a controlled terminal:

```bash
tmux new-session -d -s jtui-test -x 100 -y 28
tmux send-keys -t jtui-test "./jtui-dev.sh" Enter
sleep 5 && tmux capture-pane -t jtui-test -p
tmux kill-session -t jtui-test
```

## How the rendering works

The screen is split in two. Finished output — user prompts, tool results, completed assistant
messages — is committed to terminal scrollback and never redrawn. Only the live region at the
bottom (the streaming reply, spinner, editor, status bar) is re-rendered, and each frame rewrites
only the rows whose content actually changed.

While a reply streams, lines that can no longer change are moved into the static region as they
finalize. A long answer therefore neither flickers nor appears twice in scrollback, and the redraw
cost stays flat no matter how long the conversation gets.

## License

MIT
