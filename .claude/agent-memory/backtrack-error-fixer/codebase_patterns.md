---
name: Codebase Patterns
description: Key architectural constraints and recurring fix patterns in BackTrack
type: project
---

## Architecture constraints

- `RollbackEvent.id` and `RollbackToast.id` must be the same type — they flow through
  RecentDeployment → RollbackEventCard and page.tsx → RollbackToastStack. Changing one
  requires changing all four files.
- `monitoring-store.ts` uses sync file I/O (`fs.readFileSync/writeFileSync`) but is called
  from async Next.js API routes. Write serialization is via a module-level `_writeLock`
  promise chain — not a real file lock, but serializes concurrent JS calls.
- The agent `/health` endpoint is the canonical source for agent-side configuration values
  (like `min_readings`). Add new frontend-visible constants there, not via a separate endpoint.
- `config._forced_mode` (not `os.environ`) is the thread-safe way to override mode in the
  Python agent. Do not write to `os.environ` from async FastAPI handlers.

## Recurring patterns

- Many bugs in the dirty files were already fixed before the session — always read the
  current file state before editing; don't assume the bug report describes the current state.
- TypeScript `id` fields that flow through callbacks must be updated in the type definition
  AND all callback signatures that reference that type.
- When adding new metrics/fields to agent endpoints, use `from module import CONSTANT` inside
  the endpoint function to avoid circular import issues at module load time.
