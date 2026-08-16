# Antigravity Integration

jtui supports an alternative backend engine called **Antigravity**, which routes
model requests through the **Antigravity CLI** instead of calling Vertex AI
directly. This allows jtui to run inside Antigravity sandboxes where Antigravity
handles authentication, rate limiting, and model routing. The integration is
controlled via the `--engine antigravity` CLI flag or the `engine` field in the
jtui config file.

## Completed Work

### `EngineMode` type and `ModelClient` interface

**File:** `packages/ai/src/engine.ts`

- Defined `EngineMode = "gcloud" | "antigravity"` union type.
- Defined the `ModelClient` interface that both `VertexClient` and
  `AntigravityClient` implement. Methods: `stream()`, `entryFor()`,
  `resolveApi()`, `catalog`, `pricing`.
- Exported from `packages/ai/src/index.ts`.

### `AntigravityClient` implementation

**File:** `packages/ai/src/antigravity.ts`

| Export | Purpose |
|---|---|
| `findAntigravityCli()` | Resolves the Antigravity CLI binary from `JTUI_ANTIGRAVITY_CLI` / `JTUI_ANTIGRAVITY_CLI_PATH` |
| `discoverAntigravityModels()` | Probes the Antigravity CLI to discover available models |
| `AntigravityClient` | `ModelClient` implementation that spawns the Antigravity CLI per request |
| `AntigravityCliNotFoundError` | Error with setup hints when the CLI is missing |

Key implementation details:

- Spawns the CLI with `--print --output-format=stream-json` for each request.
- Translates Antigravity JSONL events (`init`, `step_update`, `result`) into jtui's
  `StreamEvent` protocol.
- Handles abort signals, thinking levels, and error propagation.
- `serializeContext()` helper flattens multi-turn context into a single prompt
  string.
- Strips `ANTIGRAVITY_*` environment variables to avoid sandbox conflicts.

### CLI `--engine` flag

**File:** `packages/cli/src/args.ts`

- Added `engine?: "gcloud" | "antigravity"` to `ParsedArgs`.
- Added switch-case parsing with validation for the `--engine` flag.
- Documented in the `USAGE` help text.

### Config file support

**File:** `packages/cli/src/config.ts`

- Added `engine?: EngineMode` to the `JtuiConfig` type with docstring.
- Imported `EngineMode` from `@jtui/ai`.

### Engine wiring in `main.ts`

**File:** `packages/cli/src/main.ts`

- The CLI entry point branches on `args.engine ?? fileConfig.engine ?? "gcloud"`.
- **Antigravity path:** calls `findAntigravityCli()`, `discoverAntigravityModels()`,
  and constructs an `AntigravityClient`. Skips `verifyCredentials()`.
- **gcloud path:** preserved as-is with `VertexClient`.
- Extracted `runWithClient()` helper that both paths call with a `ModelClient`.

### Mode interfaces widened to `ModelClient`

- `PrintOptions.client` in `packages/cli/src/modes/print.ts` — now
  `ModelClient`.
- `InteractiveOptions.client` in `packages/cli/src/modes/interactive.ts` — now
  `ModelClient`.
- `compact()` in `packages/agent/src/compaction.ts` — parameter widened from
  `VertexClient` to `ModelClient`.
- `printBanner()` — shows "coding agent via Antigravity" and the Antigravity
  engine line instead of project/location.
- `updateStatus()` — shows "antigravity" instead of project/location.
- `/location` command — disabled with a message in antigravity mode.
- `/models` command — falls back to cached catalog when not on VertexClient.
- `chooseModel()` — only attempts `loadCatalog()` when the client is a
  `VertexClient`.

## Remaining Tasks

### Task 1 — `VertexClient implements ModelClient` *(MEDIUM)*

**File:** `packages/ai/src/client.ts`

`VertexClient` does not explicitly declare `implements ModelClient`. Adding the
declaration ensures the compiler will catch any drift between the interface and
the implementation.

### Task 2 — Tests *(MEDIUM)*

- `parseArgs` tests for `--engine` (valid values, invalid values, missing
  value).
- Unit tests for `AntigravityClient` with a mocked Antigravity subprocess.
- Integration tests for engine selection logic in `main.ts`.

### Task 3 — Auto-detection *(LOW)*

Consider defaulting to `"antigravity"` automatically when:

- `ANTIGRAVITY_*` environment variables are present (indicates an Antigravity
  sandbox), or
- `findAntigravityCli()` finds the binary and no gcloud credentials are configured.

## Architecture

```
┌─────────────┐
│  Agent Loop  │  (packages/agent — uses ModelClient)
└──────┬───────┘
       │ ModelClient
       ▼
┌──────────────────────────────────────────┐
│            engine.ts                     │
│  ModelClient interface                   │
│  stream() · entryFor() · resolveApi()   │
│  catalog  · pricing                      │
└──────┬────────────────────┬──────────────┘
       │                    │
       ▼                    ▼
┌──────────────┐   ┌───────────────────┐
│ VertexClient │   │ AntigravityClient │
│ (gcloud)     │   │ (Antigravity CLI) │
└──────┬───────┘   └────────┬──────────┘
       │                    │
       ▼                    ▼
   Vertex AI API      Antigravity process
```

The `ModelClient` interface in `engine.ts` is the abstraction boundary. The
agent loop, compaction, and all mode runners depend only on `ModelClient`; they
are unaware of which backend is active.

`AntigravityClient` does **not** call Vertex AI directly — it shells out to the
Antigravity CLI for every request. Antigravity handles authentication, rate
limiting, and model routing internally.

## Running in Antigravity Mode

> [!NOTE]
> The core wiring is complete. Tasks 1–3 above are polish / hardening.

Once the remaining wiring is in place, users can run jtui with Antigravity in
three ways:

**CLI flag:**

```sh
jtui --engine antigravity "Summarize this file"
```

**Config file** (`~/.config/jtui/config.json`):

```json
{
  "engine": "antigravity"
}
```

**Auto-detection** *(Task 7, not yet implemented):*

When running inside an Antigravity sandbox, jtui will detect `ANTIGRAVITY_*`
environment variables and select the antigravity engine automatically.

### Prerequisites

- The Antigravity CLI must be installed, and its path set via `JTUI_ANTIGRAVITY_CLI`
  (or `JTUI_ANTIGRAVITY_CLI_PATH`). Put this in `.env` or `~/.jtui/.env`; see
  `.env.example`. The path is deployment-specific and is never committed.
- No gcloud credentials or Vertex AI project configuration is required —
  Antigravity manages its own auth.
