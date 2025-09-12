# UI Implementation Plan (Next.js Management UI)

## 1. Objectives
Provide a lightweight management interface at `/ui` that lets a user (authenticated only via their API key) do the following without adding new backend endpoints:
- Enter/store API key locally (no server-side session) and auto‑reuse it.
- List accessible projects (owned + shared) using `list_projects` MCP tool.
- Create/init a new project (`init_project`).
- Share / revoke project access (use existing REST `/project/share` and `/project/status`).
- View & edit `AGENTS.md` (full‑file edit only) via `read_agent` + `write_agent (mode=full)`, with markdown syntax highlighting & preview.
- View structured tasks (aka progress) as a 4‑column Kanban: Pending, In Progress, Completed, Archived (uses `read_progress`).
- Drag & drop tasks across columns to change status (`progress_set_new_state`).
- Add new tasks (`generate_task_ids` + `progress_add`).
- View commit log history for a project (`list_project_logs`) to show recent changes (optional nice‑to‑have).
- Toast notifications for success/error.

## 2. Constraints & Requirements
- All project/task/docs operations MUST use existing MCP tools (POST `/mcp?apiKey=...`).
- No new backend endpoints added; only integrate Next.js into current Express server.
- Share operations use the already existing REST endpoints (`/project/share`, `/project/status`) with the API key as Bearer token.
- Serve the UI at `http://<host>:<port>/ui` (and ensure assets work) → use `next.config.(js|mjs)` with `basePath: '/ui'`.
- Keep all UI source code under `src/ui`.
- Markdown editing is full‑document only (no patch/diff mode).
- Minimal additional dependencies (already installed): next, react, react-dom, @uiw/react-md-editor, @uiw/react-markdown-preview, remark-gfm, @hello-pangea/dnd, swr, clsx, react-hot-toast, dayjs.

## 3. High-Level Architecture
- Integrate Next inside `index.js` using custom server mode:
  ```js
  import next from 'next';
  const nextApp = next({ dev: NODE_ENV !== 'production', dir: path.join(__dirname, 'src', 'ui') });
  await nextApp.prepare();
  const handle = nextApp.getRequestHandler();
  app.use('/ui', (req,res)=>handle(req,res));
  // Also allow `/_next` when basePath fallback needed; but with basePath set we mainly need `/ui/_next`.
  ```
- `next.config.mjs` with `basePath: '/ui'` + `reactStrictMode: true`.
- Frontend API layer `lib/mcpClient.ts|js` wrapping `fetch` against `/mcp?apiKey=...` building JSON-RPC with incrementing id. (Simplified: `{ jsonrpc:'2.0', method:'tool', params:{ name, arguments } }` as required by transport.) Parse text result: The server returns `{ content: [{ type: 'text', text }] }`; we extract `text` and JSON.parse when needed.
- SWR hooks encapsulating: useProjects, useAgentDoc(projectId), useTasks(projectId), useLogs(projectId).
- State: API key stored in `localStorage` + React context (`ApiKeyContext`). When missing, show a Login screen (single input) before exposing rest of UI.
- Kanban: Column components mapping statuses; drag result triggers update.
- Optimistic updates with rollback on failure for drag and task add.

## 4. Data Contracts (Simplified)
- callTool(name,args) → POST `/mcp?apiKey=KEY` body: `{ jsonrpc:'2.0', id:n, method:'call_tool', params:{ name, arguments: args } }`.
  Response shape (from SDK transport) → unwrap `result.content[0].text`.
- Tasks object from `read_progress`: `{ tasks: [{ task_id, task_info, parent_id, status, extra_note }], markdown }`.
- Project listing: `{ projects: [{ id, name, owner_id, permission, read_only }] }`.

## 5. Pages / Routes (App Router)
- `/ui` → Dashboard / Project list + quick create.
- `/ui/projects/[id]` → Tabs: [Kanban] [AGENTS.md] [Share] [History]
  - Tab state via search param (?tab=agents / tasks / share / history).

## 6. Component Inventory
- `components/Layout` – Shell with API key status + nav + toast container.
- `components/ApiKeyGate` – Ensures key presence, provides setter.
- `components/ProjectList` – Lists, create form, links.
- `components/AgentEditor` – Markdown editor (MDEditor) with load/save buttons + autosave (debounced).
- `components/KanbanBoard` – 4 Columns using `<DragDropContext>` + `<Droppable>` + `<Draggable>`.
- `components/TaskAddForm` – Generate ID + quick add.
- `components/SharePanel` – Form to enter target user id + permission (ro/rw) + revoke; shows current status via `/project/status?project_id=...`.
- `components/HistoryList` – Commit logs (dayjs relative time).
- `components/Loading` / `components/ErrorState` – Basic states.

## 7. Kanban Mapping
| Column | Status value | Title |
|--------|--------------|-------|
| Pending | `pending` | Pending |
| In Progress | `in_progress` | In Progress |
| Completed | `completed` | Completed |
| Archived | `archived` | Archived |

Drag rules:
- Source task_id + destination column status → call `progress_set_new_state` args: `{ project_id, match:[task_id], state:newStatus }`.
- On success: mutate SWR cache; on failure: revert + toast error.

## 8. AGENTS.md Editing Flow
1. Load via `read_agent` tool.
2. Store original & edited state.
3. Save button (enabled when dirty) → `write_agent` with `{ mode: 'full', content }`.
4. On success: update original, toast success.
5. Provide optional preview toggle (MDEditor has built-in preview / or use Markdown preview component).

## 9. Sharing Flow
- Input: target user id, select permission (ro / rw).
- POST `/project/share` body: `{ project_id, target_user_id, permission }` with `Authorization: Bearer <apiKey>`.
- Revoke: same call with `revoke:true` or permission `'none'` (depending on API expectation). (From docs: same endpoint with `revoke?`; include `revoke:true`).
- Refresh status via GET `/project/status?project_id=...`.

## 10. Error & Auth Handling
- If a MCP call returns JSON string containing `{ error: 'read_only_project' }`, disable write actions & show RO badge.
- Global fetch wrapper: if network 401/403 → prompt re-enter API key.

## 11. Performance / UX Enhancements (Phase 2, optional)
- Debounced autosave for AGENTS.md (2s idle) with dirty indicator.
- Skeleton loading states for Kanban.
- Batch revalidation after task move.
- Persist last selected project & tab in localStorage.

## 12. Implementation Phases & Task Checklist
### Phase A – Scaffolding
- [x] Add Next.js integration in `index.js` (prepare + mount handler) with basePath.
- [x] Create `src/ui/next.config.mjs` (basePath, reactStrictMode).
- [x] Add `src/ui/app/layout.jsx` & global styles.
- [x] Add `ApiKeyContext` + provider.
- [x] Implement initial Login screen (API key input, localStorage persistence) shown when no key present.

### Phase B – Core Pages
- [x] Dashboard page (`/ui`) with project list + create form.
- [x] Project detail route with tab framework.

### Phase C – Features
- [x] MCP client utility (JSON-RPC wrapper) + SWR hooks.
- [x] Project list hook + create project form.
- [x] Agent editor (read/write full file).
- [x] Tasks Kanban (read + DnD status updates).
- [x] Task add form (generate id + add).
- [x] Share panel (share/revoke + status display).
- [x] History panel (commit logs).

### Phase D – Polish
- [x] Toast notifications integration.
- [x] Error boundaries / fallback UI. (Added custom client ErrorBoundary wrapping layout with reset + reload)
- [x] Autosave AGENTS.md (debounced ~1.8s idle, silent save toast, manual save still available).
- [x] Relative timestamps with dayjs (last saved indicator in AGENTS.md editor).
- [x] Loading skeletons. (Project list, Kanban columns, Agent editor)
- [x] Persist last selected project & tab in localStorage.
- [x] Autosave enable/disable toggle for AGENTS.md.
  

### Phase E – QA & Docs
- [x] Manual smoke test: list/create/share/edit/move tasks/edit agent.
- [ ] Update `README.md` quickstart UI section.
- [ ] Verify production start (NODE_ENV=production).

## 13. Open Questions / Assumptions
- Assumption: Using only structured tasks (no separate `progress.md` file) is acceptable—the Kanban represents these structured tasks.
- Assumption: Archive column is visible & draggable (allowed). If restricted, we can disable dragging out of Archived except to Pending.
- Assumption: Revoke share uses `{ revoke:true }` as documented.
- Assumption: Users know target user id for sharing (we’re not building a user search UI now).

## 14. Risk Mitigation
| Risk | Mitigation |
|------|------------|
| Next basePath asset mismatch | Use `basePath:'/ui'` + mount handler at `/ui`.
| JSON parsing errors (plain text responses) | Guard `try/catch` parse; expose raw text on failure.
| Drag causing race conditions | Disable board while a move is pending; optimistic UI with rollback.
| Large AGENTS.md perf | Debounce editor save + no realtime preview by default.

### Production Build Note
`next export` deprecated: we rely on `output: 'standalone'` and `pnpm build:ui` then start the existing Express server. Static export is not needed because the UI makes dynamic tool calls.

## 15. Minimal JSON-RPC Envelope Example
```json
{
  "jsonrpc":"2.0",
  "id":1,
  "method":"call_tool",
  "params":{
    "name":"list_projects",
    "arguments":{}
  }
}
```
Response body (transport style):
```json
{
  "jsonrpc":"2.0",
  "id":1,
  "result":{
    "content":[{"type":"text","text":"{\n  \"projects\": []\n}"}]
  }
}
```

## 16. Success Criteria
- Visiting `/ui` with no API key shows dedicated login screen (centered form) requesting API key.
- Valid key lists projects within 1–2s (SWR caching thereafter).
- Editing & saving AGENTS.md updates hash & shows success toast.
- Dragging task between columns immediately reflects new column & persists after refresh.
- Creating a task appears in appropriate column instantly.
- Share panel can grant & revoke access (confirmed by status reload).

---
(Will update checkbox state as implementation proceeds.)
