# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Project Overview

This is an MCP (Model Context Protocol) server exposed over Streamable HTTP for storing and updating project-level AGENTS.md and structured progress tasks per project.
Progress tracking uses a structured tasks model stored in SQLite (via `sql.js`, persisted to `data/app.sqlite`). You can nest tasks by setting `parent_id` to the root task’s `task_id`; nesting can be arbitrarily deep.

## UI Management Console (/ui)

An integrated Next.js (App Router) management interface is mounted at `/ui` within the existing Express server. It enables authenticated users (API key only) to:

- List/create/delete/rename projects (respecting ownership & permissions).
- Edit `AGENTS.md` with full‑file markdown editor (autosave toggle + manual save, contextual commit messages).
- View and manage tasks in a 4‑column Kanban (Pending / In Progress / Completed / Archived) with drag & drop status changes.
- Create new tasks (ID generation via MCP tool) with auto commit comments.
- Hierarchically nest tasks (arbitrary depth) by selecting parent; collapse/expand any task with persisted state.
- Hide descendant tasks across other columns when an ancestor root is collapsed (reduces visual noise while keeping local hierarchy intact).
- Edit task properties (name, status, parent) through a modal with cycle protection and contextual commit logging.
- Inspect commit history (logs) for each project.
- Share projects (grant/revoke RO/RW) via existing REST endpoints.
- Upload, list, and delete project documents in the Files tab (PDF/MD/TXT). Files respect project permissions; RO users can only view metadata.
- Toggle theme (light / dark / system) with system preference sync; theme preference is persisted.

### UI Technical Notes

- All write operations generate contextual commit messages (task creation, moves, property edits, project rename, AGENTS.md writes).
- Theme implemented via CSS custom properties; no remaining hard-coded dark palette values in components (light mode is first-class).
- Skeleton loaders (projects, Kanban, agent editor) provide perceived performance boost.
- ErrorBoundary wraps client UI with reset + reload actions.
- LocalStorage persists: API key, last opened project, last active tab, collapsed task ids, theme preference, AGENTS.md autosave setting.

### Adding / Modifying UI Components

- Use existing theme tokens (`globals.css`) instead of literal hex values. If a needed semantic color is missing, add paired light/dark tokens.
- For new task mutations, include a short commit `comment` to preserve meaningful history.
- Maintain accessibility: ensure buttons have discernible text or `aria-label`; extend focus styles if adding new interactive components.

### Future Enhancements (Candidates)

- Keyboard navigation for Kanban (arrow keys + Enter to open task modal).
- Filter/search tasks by text or status, inline quick edit.
- Diff/patch mode for AGENTS.md (server supports patch/diff operations already).
- Optional compact density mode + user preference persistence.


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
   - `AI_API_TYPE`: one of `google | openai | groq | openai_com | mcp` (synonyms accepted: `gemini`→`google`, `oa`/`oai`→`openai`, `openai-compatible`/`compat`→`openai_com`)
   - `AI_API_KEY`: provider API key (required when enabled)
   - `AI_MODEL`: model id; defaults per provider when omitted: `google: gemini-2.5-pro`, `openai: gpt-5-mini`, `groq: openai/gpt-oss-120b`, `openai_com: gpt-4o-mini`, `mcp: gpt-4o-mini`
   - `AI_BASE_ENDPOINT`: optional base URL for OpenAI‑compatible or self‑hosted endpoints (used by `openai_com` and `mcp`)
   - `AI_TIMEOUT`: hard timeout in seconds for subagent runs (default `120`)

## Architecture

Minimal Node.js ESM app with Express + MCP Streamable HTTP:
- `index.js` — Express app, MCP server (Streamable HTTP) at `POST /mcp`; defines and wires all MCP tools; mounts admin router under `/auth`.
- `src/db.js` — SQLite (sql.js) persistence, schema and CRUD for users, projects, and structured tasks (including cascade + lock rules).
- `src/project.js` — Express router for project file uploads (list/upload/delete) with on-disk storage and permission checks.
- `src/auth.js` — Admin auth middleware (Bearer `MAIN_API_KEY`), user API key auth for MCP, and `/auth` routes.
- `src/env.js` - Read and load .env file.
- `src/ext_ai/` — External AI subagent controller and providers:
  - `ext_ai.js`: central controller (selects provider based on `AI_API_TYPE`, normalizes tools, manages run status, and appends results to scratchpads).
  - `gemini.js`, `openai.js`, `groq.js`, `openai_com.js`, `aisdkmcp.js`: provider modules, each exporting a single `infer(...)` for plug‑and‑play use. The `mcp` provider (`aisdkmcp.js`) uses `@ai-sdk/openai-compatible` for the model and loads MCP tools from `subagent_config.json` (stdio or HTTP/SSE). It records a concise `toolcall_history` (inputs only).
  - `subagent_config.json`: MCP client config at repo root. Define servers under `mcpServers` by either `{ command, args }` (stdio) or `{ serverUrl }` (HTTP or SSE). Each entry may include `short_descriptions` (recommended, used by the UI hints).
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

Expose these tools via MCP CallTool (Streamable HTTP). All tools operate by project_id (except init_project, which creates a new project by name and returns its id):
- `list_projects`: Lists accessible projects. Returns `{ projects: [{ id, name, owner_id, permission, read_only }] }`.
- `init_project`: Create/init project `{ name, agent?, progress? }`. Returns `{ id, name, hash }`.
- `delete_project`: Delete a project `{ project_id }` (owner only).
- `rename_project`: Rename a project `{ project_id, newName, comment? }` (owner only).
- `read_agent`: Read AGENTS.md `{ project_id, lineNumbers? }` (RO/RW/owner).
- `write_agent`: Write AGENTS.md `{ project_id, mode=full|patch|diff, content|patch, comment? }` (RW/owner). Patch/diff requires a unified diff. On success, responses include the updated `hash`.
- `read_progress`: Read structured tasks `{ project_id, only? }` → `{ tasks, markdown }`. `only` filters by `pending | in_progress | completed | archived` (synonyms accepted). Archived tasks are excluded unless explicitly requested.
- `progress_add`: Add structured tasks `{ project_id, item, comment? }`. Duplicate `task_id` are skipped in `skipped`. Creates a new commit; response includes `hash` when items were added.
- `progress_set_new_state`: Update tasks `{ project_id, match, state?, task_info?, parent_id?, extra_note?, comment? }`. Completing or archiving cascades to descendants. Lock rules apply (cannot edit locked items unless unlocking).
- `generate_task_ids`: Generate N unique 8‑char IDs `{ count? }`.
- `get_agents_md_best_practices_and_examples`: Best‑practices + examples from `example_agent_md.json`.
- `list_project_logs`: List commit logs `{ project_id }` → `{ logs: [{ hash, message, modified_by, created_at }] }`. The `modified_by` field shows the username of who made each commit.
- `revert_project`: Revert a project `{ project_id, hash }`. Participants can only revert to commits in their most recent consecutive sequence from the end (to prevent discarding others' work). On success, response includes `{ project_id, hash }`.

Scratchpad (ephemeral) tools:
- `scratchpad_initialize`: Start a new scratchpad for a one‑off task `{ name, tasks }`. The server generates and returns a random `scratchpad_id`. Returns `{ scratchpad_id, project_id, tasks, common_memory }`.
- `review_scratchpad`: Review a scratchpad `{ name, scratchpad_id, IncludeCM?, IncludeTk? }`.
  - `IncludeCM` (boolean): include `common_memory` when `true`.
  - `IncludeTk` (array of strings): include only matching tasks; matches `task_id` (case‑insensitive exact) or `task_info` substring (case‑insensitive).
  - If neither option is provided, outputs both `tasks` and `common_memory`. Otherwise, returns only the requested fields; if `IncludeTk` is omitted, tasks are not returned.
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
- File uploads do not create commits; ensure important documentation updates are reflected in AGENTS.md or task notes manually.
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

## Project REST API (/project) and Sharing Model

Use these REST endpoints to manage cross-user sharing and visibility. All endpoints live under `/project` and require authentication.

- Auth (admin): Bearer `MAIN_API_KEY` in `Authorization` header.
- Auth (user): provide user apiKey (from `/auth/users`) as Bearer token or `?apiKey=...` query param.

Endpoints:
- `GET /project/list`
  - Admin: returns `{ scope: 'admin', projects: [{ id, name, owner_id, owner_name }] }` across all users.
  - User: returns `{ scope: 'user', projects: [{ id, name }] }` for owned + shared projects; read-only shares append `" (Read-Only)"` to `name`.

- `POST /project/share`
  - Body: `{ project_id, target_user_id, permission, revoke? }`
  - `permission`: `'ro'` (read-only) or `'rw'` (read/write).
  - Only the owner can share/revoke their projects; admins may share/revoke any.
  - Response: `{ ok: true, project_id, owner_id, target_user_id, permission }` where `permission` reflects the resulting state (`'ro' | 'rw' | 'none'`).

- `GET /project/status?project_id=...`
  - Owner/Admin response: `{ owner: { id, name }, project: { id, name }, shared_read: [{ id, name }], shared_read_write: [{ id, name }] }`.
  - Shared participant response: `{ owner: { id, name }, project: { id, name }, your_permission: 'ro'|'rw' }`.
  - Others (no access): `404` with `{ error: 'project_not_found' }`.

### Project Files (`/project/files`)
- Storage: Uploaded binaries are saved under `data/<project_id>/<file_id>` where `file_id` is a random 16-character hex string. Metadata persists in `project_files` (original name, MIME type, uploader id, timestamps).
- Permissions: Owners and RW participants may upload or delete. RO participants may list metadata only (write attempts return `403`).
- `POST /project/files`
  - Multipart form accepting `project_id` and a single `file` (`.pdf|.md|.txt`, ≤20 MB). Uploading the same original filename replaces the previous version and deletes the old blob.
- `GET /project/files?project_id=...`
  - Returns `{ project_id, permission, files: [{ file_id, original_name, file_type, uploaded_by, created_at, updated_at }] }`.
- `DELETE /project/files/:fileId?project_id=...`
  - Removes metadata and the stored binary when the caller has write access; returns `404` if missing.

Sharing Data Model and Rules:
- Project ownership stays with the original creator (row in `user_projects`).
- Shares are stored as two JSON arrays on the project row:
  - `ro_users_json`: user IDs with read-only access.
  - `rw_users_json`: user IDs with read-write access.
- A user may be in at most one list (server enforces moving between lists atomically when permission changes).

Permissions and Effects:
- Owner: full control, can share/revoke; owns all backups/version history.
- Read-only (RO):
  - Can list/see the project via REST and read via MCP tools.
  - MCP write attempts return `{ error: 'read_only_project' }`.
  - In REST listing, the project `name` includes `" (Read-Only)"` as a suffix for clarity.
- Read-write (RW):
  - Can read and write via MCP tools.
  - All backups remain under the owner's user_id.
  - Cannot rename projects (owner only).
  - Can only revert to commits in their most recent consecutive sequence from the end.

MCP + IDs (important):
- All MCP tools use `project_id` (except `init_project`, which creates by `name` and returns `id`).
- Always call `list_projects` first to obtain `{ id }` and then pass `project_id` to subsequent MCP tools.

Examples (curl):
- Admin list all projects:
  - `curl -H "Authorization: Bearer $MAIN_API_KEY" http://localhost:3000/project/list`
- User list own + shared:
  - `curl "http://localhost:3000/project/list?apiKey=$USER_API_KEY"`
- Owner share RO to another user:
  - `curl -X POST -H "Authorization: Bearer $OWNER_API_KEY" -H "Content-Type: application/json" \
     -d '{"project_id":"<pid>","target_user_id":"<uid>","permission":"ro"}' \
     http://localhost:3000/project/share`
- Admin upgrade to RW:
  - `curl -X POST -H "Authorization: Bearer $MAIN_API_KEY" -H "Content-Type: application/json" \
     -d '{"project_id":"<pid>","target_user_id":"<uid>","permission":"rw"}' \
     http://localhost:3000/project/share`
- Status (owner/participant/admin):
  - `curl -H "Authorization: Bearer $API_KEY" "http://localhost:3000/project/status?project_id=<pid>"`

## Testing Notes

- `node test/test-files.js` exercises the `/project/files` workflow (owner/RW uploads, RO restrictions, replacement + delete cleanup).
