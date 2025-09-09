Project ID Migration Plan

Goal: Move all MCP tool operations and DB functions from project name-based selection to project_id-based selection (except init_project, which still creates by name and returns id). Remove legacy name-based methods and ambiguity handling.

Scope
- src/db.js: Replace name-based APIs with project_id variants; add permission resolution by project_id. Keep init_project (by name) only.
- index.js: Update MCP tool input schemas and handlers to accept and use project_id; return richer list_projects; drop ambiguous name logic.
- src/version.js: Update to use project_id for commits/logs/reverts.
- src/ext_ai/ext_ai.js: Use project_id for scratchpad and run tracking.
- Remove obsolete helpers: getProjectByName, getProjectFull, resolveProjectAccess (name variant), and any callers.

New Conventions
- Each MCP tool (except init_project) requires `project_id`.
- Permission model: Use project row to determine caller permission via ro/rw lists.
- All task/backups/scratchpad/subagent rows use the owner’s user_id as before; resolve owner from project row.

DB API Changes (old → new)
- listProjects(userId) → listProjectsForUserWithShares(userId) [unchanged, but list_projects tool returns rich objects]
- resolveProjectAccess(userId, name) → resolveProjectAccessById(userId, projectId)
- getProjectByName(userId, name) → getProjectById(projectId)
- getProjectFull(userId, name) → getProjectFullById(ownerId, projectId)
- initProject(userId, name, data) [unchanged signature]
- deleteProject(userId, name) → deleteProjectById(ownerId, projectId)
- renameProject(userId, oldName, newName) → renameProjectById(ownerId, projectId, newName)
- readDoc(userId, name, which) → readDocById(ownerId, projectId, which)
- writeDoc(userId, name, which, content) → writeDocById(ownerId, projectId, which, content)
- ensureProjectVersionInitialized(userId, name) → ensureProjectVersionInitializedById(ownerId, projectId)
- createProjectBackup(userId, name, message) → createProjectBackupById(ownerId, projectId, message)
- listProjectLogs(userId, name) → listProjectLogsById(ownerId, projectId)
- revertProjectToHash(userId, name, hash) → revertProjectToHashById(ownerId, projectId, hash)
- listTasks(userId, projectName, { only }) → listTasksById(ownerId, projectId, { only })
- addTasks(userId, projectName, tasks) → addTasksById(ownerId, projectId, tasks)
- replaceTasks(userId, projectName, tasks) → replaceTasksById(ownerId, projectId, tasks)
- setTasksState(userId, projectName, updates) → setTasksStateById(ownerId, projectId, updates)
- initScratchpad(userId, projectName, scratchpadId, tasks) → initScratchpadById(ownerId, projectId, scratchpadId, tasks)
- getScratchpad(userId, projectName, scratchpadId, opts) → getScratchpadById(ownerId, projectId, scratchpadId, opts)
- updateScratchpadTasks(userId, projectName, scratchpadId, updates) → updateScratchpadTasksById(ownerId, projectId, scratchpadId, updates)
- appendScratchpadCommonMemory(userId, projectName, scratchpadId, toAppend) → appendScratchpadCommonMemoryById(ownerId, projectId, scratchpadId, toAppend)
- createSubagentRun(userId, projectName, runId, status) → createSubagentRunById(ownerId, projectId, runId, status)
- setSubagentRunStatus(userId, projectName, runId, status) → setSubagentRunStatusById(ownerId, projectId, runId, status)
- getSubagentRun(userId, projectName, runId) → getSubagentRunById(ownerId, projectId, runId)

Index.js MCP Tool Changes
- list_projects: return `{ projects: [{ id, name, owner_id, permission, read_only }] }`.
- init_project: unchanged input (`name`), return `{ id, name, hash }` + extras.
- delete_project: `{ project_id }` (owner only).
- rename_project: `{ project_id, newName, comment? }` (owner only).
- read_agent: `{ project_id, lineNumbers? }`.
- write_agent: `{ project_id, mode=full|patch|diff, content|patch, comment? }`.
- read_progress: `{ project_id, only? }` → returns `{ tasks, markdown }`.
- progress_add: `{ project_id, item, comment? }` (items array or JSON-stringified array).
- progress_set_new_state: `{ project_id, match, state?, task_info?, parent_id?, extra_note?, comment? }`.
- list_project_logs: `{ project_id }`.
- revert_project: `{ project_id, hash }`.
- scratchpad_initialize: `{ project_id, tasks }` → returns scratchpad with server-generated `scratchpad_id`.
- review_scratchpad: `{ project_id, scratchpad_id, IncludeCM?, IncludeTk? }`.
- scratchpad_update_task: `{ project_id, scratchpad_id, updates }`.
- scratchpad_append_common_memory: `{ project_id, scratchpad_id, append }`.
- scratchpad_subagent: `{ project_id, scratchpad_id, task_id, prompt, sys_prompt?, tool? }`.
- scratchpad_subagent_status: `{ project_id, run_id }`.

Permission Resolution
- Implement `resolveProjectAccessById(userId, projectId)` in db.js returning `{ owner_id, project_id, permission } | null`.
- Owner: full access, RW: read/write, RO: read-only (write attempts error `{ error: 'read_only_project' }`).

Versioning Changes (src/version.js)
- Switch all exports to accept `(ownerId, projectId, ...)`.
- Commit messages preserve existing behavior, including `Modified by <user>` prefix for RW edits.

External AI (src/ext_ai/ext_ai.js)
- Change subagent entry to accept `project_id` instead of name; update all DB calls to by‑id variants.

Removal
- Delete/inline all name-based resolvers and callers; no backward compatibility paths.

Order of Work
1) Refactor db.js: add `resolveProjectAccessById`, add by‑id versions, remove name-based ones.
2) Update version.js to call by‑id functions.
3) Update ext_ai.js to use `project_id`.
4) Update index.js tool schemas and handlers; switch from name to project_id; adjust list_projects output.
5) Remove dead exports and references; quick smoke paths for import consistency.

Notes
- The DB schema already stores project_id and owner_id; no migrations needed.
- Tests and client usage must call list_projects first, then pass project_id thereafter.

