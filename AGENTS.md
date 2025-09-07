# agent.md

This file provides guidance to agents when working with code in this repository.

## Project Overview

This is an MCP (Model Context Protocol) server exposed over Streamable HTTP for storing and updating agent.md and progress tasks per project.
Progress tracking uses a structured tasks model stored in SQLite. You can nest tasks by setting `parent_id` to the root task’s `task_id`; nesting can be arbitrarily deep.

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

## Architecture

The project structure is minimal:
- `package.json` - Node.js project configuration
- Entry point: `index.js` (MCP Streamable HTTP server at `/mcp`)

## Notes

- No test framework currently configured
- No TypeScript configuration present
- No build system configured
- Use pnpm, not npm

## MCP Tools

Expose these tools via MCP CallTool:
- `list_projects` — List all project names
- `init_project` — Create/initialize project `{ name, agent?, progress? }`. `progress` may include a list of structured task objects.
- `delete_project` — Delete a project `{ name }`
- `rename_project` — Rename a project `{ oldName, newName }`
- `read_agent` — Read agent.md `{ name }`
- `read_agent` — Read agent.md `{ name, lineNumbers? }`. If `lineNumbers` is `true`, prepends `N|` before each line.
- `write_agent` — Write agent.md `{ name, content }`
- `read_progress` — Read structured tasks `{ name, only? }`. Returns JSON with `tasks` array and a `markdown` field that renders tasks as a nested outline for readability. `only` filters by `pending|in_progress|completed|archived` (synonyms supported). Archived tasks are excluded by default; they are included only if `only` contains `archived`.
- `write_progress` — Replace or add structured tasks `{ name, content, mode? }` where `content` is a list of task objects and `mode` is `replace` (default) or `add`. Use `parent_id` to reference the root task for nesting (arbitrary depth).
- `progress_add` — Add one or more structured tasks `{ name, item }`. `item` must be an array of task objects. Use `parent_id` to reference the root task for nesting. Duplicate `task_id` are not added; response includes `exists` (single) or `skipped` (list via `exists`).
- `progress_set_new_state` — Update tasks by `task_id` (8-char) or by matching `task_info` substring `{ name, match, state?, task_info?, parent_id?, extra_note? }`. `match` must be an array of strings. Archiving or completing cascades to all children (by `parent_id`) recursively. Lock rules: when a task or any ancestor is completed/archived, no edits are allowed except unlocking the task itself to `pending`/`in_progress`, and only if no ancestor is locked. Unlocking a parent propagates to its children.
- `get_agents_md_examples` — Get examples for writing AGENTS.md from `example_agent_md.json`. Optional `only` (string or JSON list) filters examples by usecase/title. Always includes `the_art_of_writing_agents_md`.

Transport: Streamable HTTP (stateless JSON response mode). Clients should POST JSON-RPC requests to `/mcp?apiKey=YOUR_USER_API_KEY`.

Structured tasks format:
- Task object: `{ task_id, task_info, parent_id?, status?, extra_note? }`.
- `task_id` MUST be exactly 8 characters, lowercase `a-z` and `0-9` only (e.g., `abcd1234`). Invalid IDs are rejected.
- `status` is one of `pending | in_progress | completed | archived` (synonyms accepted on input).
- `parent_id` (optional) should reference the root task’s `task_id` in the same project. This enables arbitrary-depth nesting; a child can itself be a root for deeper descendants.

Project selection: All task tools take a `name` (project name) parameter. The server resolves it to the correct internal `project_id`—you never need to provide `project_id` directly.

## Auth

- Protected MCP endpoint: `POST /mcp?apiKey=YOUR_USER_API_KEY`
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
