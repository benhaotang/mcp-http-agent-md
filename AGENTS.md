# agent.md

This file provides guidance to agents when working with code in this repository.

## Project Overview

This is an MCP (Model Context Protocol) server exposed over Streamable HTTP for storing and updating agent.md and progress.md files per project.

## Development Commands

- Run dev server: `pnpm dev` (nodemon + MCP Streamable HTTP at `POST http://localhost:3000/mcp`)
- Run in production: `pnpm start`

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
- `init_project` — Create/initialize project `{ name, agent?, progress? }` (for `progress`, accepts string or JSON list like `["task1","task2"]`)
- `delete_project` — Delete a project `{ name }`
- `rename_project` — Rename a project `{ oldName, newName }`
- `read_agent` — Read agent.md `{ name }`
- `write_agent` — Write agent.md `{ name, content }`
- `read_progress` — Read progress.md `{ name, only? }`. If `only` is provided, it filters items by state. Accepted values: `"todo"|"to-do"|"pending"` (to-do), `"in_progress"|"in-progress"` (in-progress), `"done"|"completed"` (done). `only` may also be a JSON list of any of these.
- `write_progress` — Write progress.md `{ name, content }` (string or JSON list like `["task1","task2"]`)
- `progress_add` — Append new items `{ name, item }` where `item` is a string or JSON list like `["task1","task2"]`. Duplicate tasks (case-insensitive, trimmed) are not added; the response includes `skipped` (or `exists` for single adds).
- `progress_set_state` — Set item state by matching text only `{ name, match, state: 'pending'|'in_progress'|'completed' }`. `match` can be a string or JSON list (e.g., `["foo","bar"]`). Response includes `notMatched` terms. If nothing matches, it also suggests pulling the updated list.
- `progress_mark_complete` — Mark item(s) completed by matching text only `{ name, match }`. `match` can be a string or JSON list. Response includes `notMatched` terms. If nothing matches, the tool suggests pulling the updated list.

Transport: Streamable HTTP (stateless JSON response mode). Clients should POST JSON-RPC requests to `/mcp?apiKey=YOUR_USER_API_KEY`.

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
