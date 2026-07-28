# Development rules

Instructions for agents (and humans) working in this repo.

## Style

- Answer the question first, then make edits.
- Be direct and concise. No filler, no emoji in commits or code.
- Say plainly whether you agree or disagree before describing what you changed.

## Code

- Read a file in full before making wide-ranging changes to it.
- No `any` unless there is no alternative. Prefer `unknown` plus a narrowing check.
- Use only erasable TypeScript syntax: no `enum`, `namespace`, parameter properties, or `import =`.
  The root config sets `erasableSyntaxOnly`, and the dev runner strips types without emitting.
- Top-level imports only. No `await import()` or inline `import("pkg").Type`.
- Intra-package imports use relative paths with the `.ts` extension. Cross-package imports use the
  bare specifier (`@jtui/ai`), which resolves to source in dev and to `dist/` when built.
- Comment what is non-obvious. Do not restate the code.
- Keep layering intact: `tui` depends on nothing, `ai` on nothing internal, `agent` on `ai`, `cli` on
  all three. Never import upward.

## Commands

After code changes:

```bash
npm run check     # biome + tsc --noEmit; fix everything it reports
npm test          # vitest
```

Do not run `npm run build` unless you are testing the packaged output.

## Tests

- Tests must not call Vertex AI. Stub the client, as `packages/agent/test/agent-loop.test.ts` does.
- Use `MemoryTerminal` to assert on TUI output; it records every byte written.
- If you touch a test, run it and iterate until it passes.

## Terminal rendering

- The TUI writes escape sequences by hand. Every helper that moves the cursor **returns** its
  sequence rather than writing it, so callers must include the return value in their buffer.
  Dropping it silently misplaces output.
- `TUI` tracks `cursorRow` as an offset inside the dynamic region. Any code path that moves the
  cursor must keep that field accurate or the next frame will render in the wrong place.
- Components render to `string[]`; lines must never contain `\n`.
- Escape sequences in source are written as `\x1b`, never as raw control bytes.

## Models

- **Never hardcode a model list.** Availability is discovered at runtime in
  `packages/ai/src/catalog.ts` and cached under `~/.jtui/catalog/`. A different account or region
  must yield a different list with no code change.
- `packages/ai/src/models.ts` derives capabilities (thinking style, limits) from the model id's
  family and version, so a model released tomorrow is handled without an edit. Add a rule there, not
  a model entry.
- The only fixed list is `PUBLISHERS` in `catalog.ts`, plus the publisher→adapter map. Models within
  a publisher are always dynamic.
- **Never invent pricing.** jtui ships no rates; they come from the user's `pricing` config. Cost
  reports as unknown otherwise, which is the honest outcome.

## Provider adapters

- One adapter per publisher API under `packages/ai/src/api/`, each exposing the same
  `stream(model, context, options)` contract and translating to and from the shared types in
  `types.ts`. `client.ts` routes; adapters never know about each other.
- Adapters must not throw for request failures — encode them as a final `done` event with
  `stopReason: "error"` so the agent loop stays uniform.
- Thinking blocks carry provider-specific signatures. When converting history, drop thinking from
  turns produced by a *different* provider (compare `AssistantMessage.model`) — replaying a foreign
  signature is rejected by the API. Both adapters have a test for this.
- Claude on Vertex: adaptive thinking plus `output_config.effort` on 4.6+, `budget_tokens` below
  that, and never send `temperature`/`top_p`/`top_k` — current models reject them.

## Google Cloud

- Authentication goes through Application Default Credentials. Never add an API-key code path
  without being asked.
- Errors from Vertex should be translated in `formatVertexError` so users get an actionable message
  (which project, which location, which command to run) rather than a bare status code.
