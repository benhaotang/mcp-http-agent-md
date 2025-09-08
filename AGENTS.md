# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Project Overview

This is an MCP (Model Context Protocol) server exposed over Streamable HTTP for storing and updating project-level AGENTS.md and structured progress tasks per project.
Progress tracking uses a structured tasks model stored in SQLite (via `sql.js`, persisted to `data/app.sqlite`). You can nest tasks by setting `parent_id` to the root task’s `task_id`; nesting can be arbitrarily deep.

## Development Commands

- Run dev server: `pnpm dev` (nodemon + MCP Streamable HTTP at `POST http://localhost:3000/mcp`)
- Run in production: `pnpm start`

## Docker

- Build image: `docker build -t mcp-http-agent-md .`
- Run container: `docker run -it --rm -p 3000:3000 -e MAIN_API_KEY=change-me -e HOST=0.0.0.0 -v $(pwd)/data:/app/data mcp-http-agent-md`
- MCP endpoint: `POST http://localhost:3000/mcp?apiKey=YOUR_USER_API_KEY`
- Admin API: `http://localhost:3000/auth` (Bearer `MAIN_API_KEY`)

Notes:
- The Docker image exposes `3000` and sets `HOST=0.0.0.0` so it’s reachable.
- The SQLite-backed data directory is persisted at `/app/data`; the run example mounts `./data` as a volume.
- You can still run locally with `npm run start` or `pnpm start`.

## Runtime & Config

- `BASE_PATH`: MCP endpoint path (default `/mcp`)
- `HOST`: interface to bind (default `localhost`)
- `PORT`: port to bind (default `3000`)
- `MAIN_API_KEY`: required for admin endpoints under `/auth`
- `.env` support: environment variables are loaded from `.env` at process start (lightweight loader in `index.js`).
 - External AI (subagent) env:
   - `USE_EXTERNAL_AI`: enable/disable external subagent tools (set to `false` to hide/disable)
   - `AI_API_TYPE`: `google`
   - `AI_API_KEY`: provider API key (required when enabled)
   - `AI_MODEL`: model id (default `gemini-2.5-pro`)
   - `AI_TIMEOUT`: hard timeout in seconds for subagent runs (default `120`)

## Architecture

Minimal Node.js ESM app with Express + MCP Streamable HTTP:
- `index.js` — Express app, MCP server (Streamable HTTP) at `POST /mcp`; defines and wires all MCP tools; mounts admin router under `/auth`.
- `src/db.js` — SQLite (sql.js) persistence, schema and CRUD for users, projects, and structured tasks (including cascade + lock rules).
- `src/auth.js` — Admin auth middleware (Bearer `MAIN_API_KEY`), user API key auth for MCP, and `/auth` routes.
- `src/env.js` - Read and load .env file.
- `example_agent_md.json` — Best practices and example snippets for AGENTS.md returned by the examples tool.
- `data/` — Persisted database directory (`app.sqlite`).
- `test.js` — Smoke test using the official MCP client transport to exercise tools end-to-end.
- `Dockerfile` — Container build; exposes `3000` and persists `/app/data`.
- `README.md` — Quickstart, Docker, and tool reference.

## Notes

- No formal test framework; `test.js` is a self-contained smoke test (`pnpm test`).
- No TypeScript; ESM JavaScript only.
- No build system; runs directly on Node.js.
- pnpm is recommended.

## MCP Tools

Expose these tools via MCP CallTool (Streamable HTTP):
- `list_projects`: List all project names.
- `init_project`: Create/init project `{ name, agent?, progress? }`. `progress` may include a list of structured task objects (see Tasks below).
- `delete_project`: Delete a project `{ name }`.
- `rename_project`: Rename a project `{ oldName, newName, comment? }`. Creates a new versioned commit; accepts optional `comment`.
- `read_agent`: Read AGENTS.md `{ name, lineNumbers? }`. If `lineNumbers` is `true`, returns lines as `N|...`.
- `write_agent`: Write AGENTS.md in `mode=full|patch|diff`. For patch/diff, provide a unified diff with `@@` hunks and lines prefixed with space/`+`/`-`. When deleting a markdown bullet that begins with `- `, start the diff line with `-- ` (delete marker + literal dash) to avoid ambiguity. Creates a new versioned commit; accepts optional `comment`. On success, responses include the updated `hash`.
- `read_progress`: Read structured tasks `{ name, only? }`. Returns JSON `{ tasks, markdown }`, where `markdown` is a nested outline. `only` filters by `pending | in_progress | completed | archived` (synonyms accepted). Archived tasks are excluded by default; include them by requesting `archived`.
- `progress_add`: Add structured tasks `{ name, item, comment? }` where `item` is an array of task objects. Duplicate `task_id` are skipped and returned via `exists/skipped`. Creates a new versioned commit if any new tasks are added; response includes `hash`.
- `progress_set_new_state`: Update tasks by `task_id` (8-char) or by matching `task_info` substring `{ name, match, state?, task_info?, parent_id?, extra_note?, comment? }`. Completing or archiving cascades to all descendants. Lock rules apply: when a task or any ancestor is `completed` or `archived`, edits are blocked except unlocking the task itself to `pending`/`in_progress` (only if no ancestor is locked). Unlocking a parent propagates. Creates a new versioned commit when changes occur; response includes `hash`.
- `generate_task_ids`: Generate N unique 8‑char IDs not used by this user `{ count? }`.
- `get_agents_md_best_practices_and_examples`: Best‑practices + examples from `example_agent_md.json`. Default returns only `the_art_of_writing_agents_md`. Use `include='all'` or a string/array to filter by usecase/title.
- `list_project_logs`: List commit logs for a project `{ name }`. Returns an ordered list of `{ hash, message, created_at }` for the current history (head-first).
- `revert_project`: Revert a project to a previous version `{ name, hash }`. Reverting sets HEAD to that hash and trims `hash_history` to that point (no branches). Older commits remain in the DB but are hidden from regular logs.

Scratchpad (ephemeral) tools:
- `scratchpad_initialize`: Start a new scratchpad for a one‑off task `{ name, tasks }`. The server generates and returns a random `scratchpad_id`. Returns `{ scratchpad_id, project_id, tasks, common_memory }`.
- `review_scratchpad`: Review a scratchpad `{ name, scratchpad_id }`. Returns `{ tasks, common_memory }`.
- `scratchpad_update_task`: Update existing scratchpad tasks by `task_id` `{ name, scratchpad_id, updates }`, where `updates` is an array of `{ task_id, status?, task_info?, scratchpad?, comments? }`. Returns `{ updated, notFound, scratchpad }`.
- `scratchpad_append_common_memory`: Append to shared scratchpad memory `{ name, scratchpad_id, append }` (string or array). Returns updated scratchpad.

External AI subagent (conditionally available):
- `scratchpad_subagent` (requires external AI enabled): Start a subagent to work on a scratchpad task `{ name, scratchpad_id, task_id, prompt, sys_prompt?, tool? }`.
  - `tool`: choose `'all'` or a subset of `[grounding, crawling, code_execution]`.
  - Automatically appends `common_memory` (if present) to the prompt.
  - Appends the agent’s result to the task’s `scratchpad`; sources and executed code (when provided by the model) are appended to `comments`.
  - Returns `{ run_id, status }`. May return early with `status: in_progress` while work continues.
- `scratchpad_subagent_status`: Check run status `{ name, run_id }`. Returns current `{ run_id, status }`. If `pending/in_progress`, it polls up to ~25s and returns the final or latest status.

Notes:
- These two tools are hidden and disabled when `USE_EXTERNAL_AI=false`.
- Default subagent identity: general problem‑solving agent. You may override via `sys_prompt`.

Why no delete/list? Scratchpads are RAM-like and expected to be cleared externally at session end. Reopen a scratchpad during the same session by `(project name, scratchpad_id)`; the server resolves `project_id` per user.

Transport: Streamable HTTP (stateless JSON-RPC). Clients POST to `/mcp?apiKey=YOUR_USER_API_KEY` or use `Authorization: Bearer <apiKey>`. `GET/DELETE /mcp` return 405.

Structured tasks format:
- Task object: `{ task_id, task_info, parent_id?, status?, extra_note? }`.
- `task_id` MUST be exactly 8 characters, lowercase `a-z` and `0-9` only (e.g., `abcd1234`). Invalid IDs are rejected.
- `status` is one of `pending | in_progress | completed | archived` (synonyms accepted on input).
- `parent_id` (optional) should reference the root task’s `task_id` in the same project. This enables arbitrary-depth nesting; a child can itself be a root for deeper descendants.

Project selection: All task tools take a `name` (project name). The server resolves it to the correct internal `project_id`—you never need to provide `project_id` directly.

## Versioning & Backups

- Automatic commits: Any successful edit to `AGENTS.md` or structured tasks (add, edit, status changes) creates a snapshot commit. `rename_project` also commits. The tool response includes the updated `hash` when a commit is created.
- Commit message: Provide a short `comment` with `write_agent`, `progress_add`, `progress_set_new_state`, or `rename_project` to set the commit message. If omitted, the server uses an ISO timestamp plus the tool name.
- Initial commit: `init_project` immediately creates an `init` commit and returns its `hash`.
- Logs: Use `list_project_logs` to retrieve `{ hash, message, created_at }` for the project’s current history.
- Reverts: `revert_project { name, hash }` restores the full snapshot (AGENTS.md + tasks) and trims the visible `hash_history` after that point. No branches are created. Admins can still access older commits if needed.

## Auth

- Protected MCP endpoint: `POST /mcp?apiKey=YOUR_USER_API_KEY` or `Authorization: Bearer <apiKey>`
- Admin endpoints (Bearer token): `MAIN_API_KEY` from `.env`
  - `POST /auth/users` — Create a user, returns `{ id, apiKey }`
  - `GET /auth/users` — List users (masked keys by default)
  - `GET /auth/users/:id` — Get user
  - `POST /auth/users/:id/regenerate` — Rotate API key
  - `DELETE /auth/users/:id` — Delete user

Set up `.env`:

```
MAIN_API_KEY=change-me
```
