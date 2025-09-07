# mcp-http-agent-md

Minimal MCP (Model Context Protocol) HTTP server to store/update project-level `AGENTS.md` and `progress.md` via tools exposed over a Streamable HTTP endpoint.

Co-authored by Codex (OpenAI).

## Run

- pnpm (recommended):
  - Install: `pnpm install`
  - Dev: `pnpm dev`
  - Prod: `pnpm start`
- npm:
  - Install: `npm install`
  - Dev: `npx nodemon --watch index.js --ext js,mjs,cjs index.js`
  - Prod: `npm run start`

Environment:
```
cp .env.example .env
# edit MAIN_API_KEY
```
Server defaults: `HOST=localhost`, `PORT=3000`, `BASE_PATH=/mcp`.

## Docker

- Build: `docker build -t mcp-http-agent-md .`
- Run (persist DB and set admin key):
```
docker run -it --rm \
  -p 3000:3000 \
  -e MAIN_API_KEY=change-me \
  -e HOST=0.0.0.0 \
  -v $(pwd)/data:/app/data \
  mcp-http-agent-md
```
- MCP endpoint: `POST http://localhost:3000/mcp?apiKey=YOUR_USER_API_KEY`
- Admin API: `http://localhost:3000/auth` (Bearer `MAIN_API_KEY`)

## Auth

- MCP: supply user `apiKey` via query `?apiKey=...` or `Authorization: Bearer ...`.
- Admin: use `Authorization: Bearer MAIN_API_KEY`.

Create a user (returns `{ id, apiKey }`):
```
curl -X POST http://localhost:3000/auth/users \
  -H "Authorization: Bearer $MAIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"alice"}'
```

## MCP Endpoint

- Base path: `POST /mcp` (Streamable HTTP, stateless JSON-RPC)

List tools:
```
curl -X POST 'http://localhost:3000/mcp?apiKey=USER_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"tools/list"}'
```

Call a tool (example – init project):
```
curl -X POST 'http://localhost:3000/mcp?apiKey=USER_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0",
    "id":"2",
    "method":"tools/call",
    "params": {"name":"init_project","arguments":{"name":"demo"}}
  }'
```

## Tools

- list_projects: List all project names.
- init_project: Create/init project `{ name, agent?, progress? }` (progress can be string or JSON list `["task1","task2"]`).
- delete_project: Delete project `{ name }`.
- rename_project: Rename project `{ oldName, newName }`.
- read_agent: Read `AGENTS.md` `{ name }`.
- write_agent: Write `AGENTS.md` `{ name, content }`.
- read_progress: Read `progress.md` `{ name, only? }` (`only` can be `todo|to-do|pending`, `in_progress|in-progress`, `done|completed`, or a list).
- write_progress: Write `progress.md` `{ name, content }` (string or JSON list).
- progress_add: Append items `{ name, item }` (string or JSON list; duplicates skipped).
- progress_set_state: Set item state by text match `{ name, match, state: 'pending'|'in_progress'|'completed' }`.
- progress_mark_complete: Mark items completed by text match `{ name, match }`.
- get_agents_md_examples: Returns examples from `example_agent_md.json`; optional `only` filter; always includes `the_art_of_writing_agents_md`.

## REST Admin API

Base: `/auth` (Bearer `MAIN_API_KEY`)
- POST `/auth/users`: Create user → `{ id, apiKey, name? }`
- GET `/auth/users`: List users (`?reveal=true` to show full keys)
- GET `/auth/users/:id`: Get user
- POST `/auth/users/:id/regenerate`: Rotate API key
- DELETE `/auth/users/:id`: Delete user

## License

MIT. See `LICENSE`.

