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
- `init_project` — Create/initialize project `{ name, agent?, progress? }`
- `delete_project` — Delete a project `{ name }`
- `rename_project` — Rename a project `{ oldName, newName }`
- `read_agent` — Read agent.md `{ name }`
- `write_agent` — Write agent.md `{ name, content }`
- `read_progress` — Read progress.md `{ name }`
- `write_progress` — Write progress.md `{ name, content }`
- `progress_add` — Append new item `{ name, item }`
- `progress_set_state` — Set item state `{ name, index?|match?, state: 'pending'|'in_progress'|'completed' }`
- `progress_mark_complete` — Mark item completed `{ name, index?|match? }`

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
