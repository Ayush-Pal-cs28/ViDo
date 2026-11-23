# Issue #30 — Task Editing, Archive/Delete, Preview Persistence, Team Permissions

> Status: implementation plan (not yet implemented)
> Scope owner: personal tasks + team tasks + preview storage + backend authorization

This plan covers:

- Editing an already-created personal task: title, description, category, priority, start date, due date, due time
- Preview persistence: edits/archives/deletes survive reload, plus “Reset demo data”
- Personal archive / restore / permanent delete, with confirmation
- Row-level `…` menu on `TaskRow` and `TaskCard` (ListView), wired to the same handlers + `ConfirmDialog`
- Team task editing: title, description, deadline, priority, milestone
- Team task archive / restore / delete
- Configurable per-team task-management policy: `lead-only` (default) or `lead-or-assignee`, enforced in Mock/Supabase/NestJS repositories, server authorization, and UI
- Calendar event deletion confirmation

Out of scope: bulk operations, undo/trash (hard delete only), moving personal tasks from `localStorage` to Firestore.

---

## Important structural note

`ListView` renders **`TaskCard`**, not `TaskRow` (`src/features/workspace/views/ListView.tsx:69`). Therefore the row-level `…` menu must live in a shared component used by **both**:

- `TaskRow` — HomeView dashboard and Tasks tab
- `TaskCard` — Today / Upcoming / Needs Attention / Completed / Archived routes

---

## 1. Data model

### `src/data/sampleTasks.ts`

```ts
export interface SampleTask {
  // ...existing fields
  archivedAt?: string;   // paired with existing isArchived
}
```

`isArchived` already exists and is respected by:

- `src/data/taskFilters.ts:38`
- `src/data/analytics.ts:67`
- `src/features/workspace/views/CalendarView.tsx:138`

So flagging a task as archived is enough for it to leave every non-archived view.

### `src/features/teams/types.ts`

```ts
export type TeamTaskEditPolicy = 'lead-only' | 'lead-or-assignee';

export interface Team {
  // ...existing fields
  taskEditPolicy?: TeamTaskEditPolicy;   // optional → default is 'lead-only'
}
```

Kept optional so existing fixtures and cached `localStorage` teams that predate the field still type-check. Code normalizes through a helper.

### `server/prisma/schema.prisma`

```prisma
model Team {
  // ...
  taskEditPolicy String @default("lead-only") // "lead-only" | "lead-or-assignee"
}
```

SQLite is managed with `prisma db push` (there is no migrations directory). Run once after the change:

```bash
npm --prefix server run prisma:push
npm --prefix server run prisma:generate
```

### `supabase/migrations/20261124000000_team_task_edit_policy.sql` (new file)

```sql
alter table teams
  add column if not exists task_edit_policy text not null default 'lead-only'
  check (task_edit_policy in ('lead-only', 'lead-or-assignee'));
```

Supabase-hosted deployments apply this manually; call it out in the PR description.

`TeamTask` / `team_tasks` need **no schema change** — `status` already accepts `'archived'`.

---

## 2. Permission helper — `src/features/teams/permissions.ts` (new, pure)

```ts
import { Team, TeamTask, UserProfile, TeamTaskEditPolicy } from './types';

export const DEFAULT_TEAM_TASK_EDIT_POLICY: TeamTaskEditPolicy = 'lead-only';

export function getTeamTaskEditPolicy(team: Team): TeamTaskEditPolicy {
  return team.taskEditPolicy ?? DEFAULT_TEAM_TASK_EDIT_POLICY;
}

export function canManageTeamTask(
  team: Team,
  task: TeamTask,
  user: UserProfile
): boolean {
  if (team.leadId === user.id) return true;
  if (
    getTeamTaskEditPolicy(team) === 'lead-or-assignee' &&
    !!task.assigneeId &&
    task.assigneeId === user.id
  ) {
    return true;
  }
  return false;
}
```

“Manage” = edit + archive + delete.

Progress updates keep their existing independent rule (`isLead || task.assigneeId === currentUser.id`); the policy does **not** change progress rights.

Unit tests: `src/features/teams/permissions.test.ts` — lead in both modes, assignee in both modes, unassigned task, legacy team with no field.

The server duplicates this rule in a private method because `server/` does not import from `src/`.

---

## 3. Repository interface + implementations

### `src/features/teams/teamRepository.ts`

```ts
export interface TeamSettingsUpdate {
  taskEditPolicy: TeamTaskEditPolicy;
}

export type TeamTaskEdit = Partial<Pick<
  TeamTask, 'title' | 'description' | 'deadline' | 'priority' | 'milestoneId'
>>;

updateTeamSettings(
  teamId: string, settings: TeamSettingsUpdate, user: UserProfile
): Promise<Team>;

updateTeamTask(
  taskId: string, patch: TeamTaskEdit, user: UserProfile
): Promise<TeamTask>;

setTeamTaskArchived(
  taskId: string, archived: boolean, user: UserProfile
): Promise<TeamTask>;

deleteTeamTask(taskId: string, user: UserProfile): Promise<void>;
```

All mutating methods now require `user` so every implementation can enforce the active policy.

### `MockTeamRepository.ts`

- Add `taskEditPolicy: 'lead-only'` to `INITIAL_MOCK_TEAMS`.
- Normalize legacy stored teams on load: `taskEditPolicy: t.taskEditPolicy ?? 'lead-only'`.
- `createTeam` sets `'lead-only'`.
- `updateTeamSettings`: lead-only; persists to `TEAMS_KEY`.
- `updateTeamTask` / `setTeamTaskArchived` / `deleteTeamTask`: load task + team, call a private `assertCanManage` using the same rule as `canManageTeamTask`; throw `Permission denied: task editing is restricted to the Team Lead` when blocked; persist.
- Restore → `status = progress === 100 ? 'completed' : 'active'`.
- Delete → filter the task out of `TASKS_KEY`.

### `SupabaseTeamRepository.ts`

- `getTeams` / `getTeam`: map `taskEditPolicy: rawTeam.task_edit_policy ?? 'lead-only'`.
- `createTeam`: insert `task_edit_policy: 'lead-only'`.
- `updateTeamSettings`: `.from('teams').update({ task_edit_policy }).eq('id', teamId).select().single()`, then re-map.
- `updateTeamTask`: fetch task row + team policy, guard via the shared rule (defense in depth), `.update({ title, description, deadline, priority, milestone_id }).select().single()`, reuse the existing row→`TeamTask` mapper.
- `setTeamTaskArchived`: `.update({ status: archived ? 'archived' : (progress === 100 ? 'completed' : 'active') })`.
- `deleteTeamTask`: `.delete().eq('id', taskId)`.
- Code comment: authoritative guarantee is Supabase RLS; the client guard mirrors Mock/server behaviour.

### `NestJsTeamRepository.ts`

- `updateTeamSettings` → `PATCH ${baseUrl}/api/teams/${teamId}/settings`
- `updateTeamTask` → `PATCH ${baseUrl}/api/tasks/${taskId}`
- `setTeamTaskArchived` → same PATCH with `{ status: 'archived' | 'active' }`
- `deleteTeamTask` → `DELETE ${baseUrl}/api/tasks/${taskId}`
- Reuse existing task/team mappers; `taskEditPolicy` passes through from the server response.

### Server (`server/src`)

**`teams.controller.ts` / `teams.service.ts`**

```ts
@Patch('teams/:teamId/settings')
updateSettings(@Param('teamId') id, @Body() { taskEditPolicy }, @CurrentUser() user)
```

- Lead-only (`team.leadId === user.uid`).
- Validate against the two allowed values.
- Persist + broadcast `team.updated`.

**`tasks.controller.ts` / `tasks.service.ts`**

```ts
@Patch('tasks/:id')     updateTask(...)
@Delete('tasks/:id')    deleteTask(...)
```

- `UpdateTaskDto`: `title?`, `description?`, `deadline?`, `priority?`, `milestoneId?`, `status?`.
- Private `canManage(task, team, user)`:

  ```ts
  const isLead = team.leadId === user.uid || task.leadId === user.uid;
  if (isLead) return true;
  return team.taskEditPolicy === 'lead-or-assignee' && task.assigneeId === user.uid;
  ```

- `updateTask`: status transitions (`archived` ↔ `active`/`completed`), preserves `progress`, `completedAt`, and checkpoints; broadcasts `task.updated`.
- `deleteTask`: `prisma.teamTask.delete` (checkpoints cascade); broadcasts `task.deleted`.
- Existing `updateTaskProgress` permissions untouched.

---

## 4. Team UI

### `TeamHeader` (in `MilestoneRoadmap.tsx`)

New props:

```ts
taskEditPolicy: TeamTaskEditPolicy;
onUpdateTaskEditPolicy?: (policy: TeamTaskEditPolicy) => Promise<void>;
```

- Lead: a labelled `<select>` / two-button toggle — **“Only Team Lead”** (default) / **“Lead + assignee”** — with helper text: “Controls who can edit, archive, or delete team tasks.”
- Member: read-only badge showing the active policy.
- Reuse existing CSS variables and `Button` / `Input` styling.

### `TeamSpaceView.tsx`

- `handleUpdateTaskEditPolicy` → `repo.updateTeamSettings(teamId, { taskEditPolicy }, currentUser)` → `setTeam(updated)`.
- State: `editingTask: TeamTask | null`, `deletingTask: TeamTask | null`.
- Handlers: `handleUpdateTask`, `handleArchiveTask`, `handleRestoreTask`, `handleDeleteTask` — all call the repo with `currentUser`, then `setTasks(prev => prev.map/filter)`.
- `filterMode` extended to `'all' | 'assigned-to-me' | 'archived'`:
  - non-archived chips exclude archived tasks
  - Archived chip shows only archived tasks
- Render the shared `ConfirmDialog` for `deletingTask`.
- Pass `taskEditPolicy` + `canManage` info down to rows; pass `onEdit/onArchive/onRestore/onDelete` callbacks.

### `TeamTaskRow.tsx`

- New props: `canManage: boolean`, `onEdit?`, `onArchive?`, `onRestore?`, `onDelete?`.
- `canManage` is computed in `TeamSpaceView` via `canManageTeamTask(team, task, currentUser)` — not recomputed ad hoc in the row.
- In the expanded panel, a “Manage task” group shows:
  - **Edit** (always for managers)
  - **Archive** (non-archived) or **Restore** (archived)
  - **Delete** (danger)
- Visually separated from progress controls.
- Members without permission see no manage controls; progress permission unchanged.
- Archived tasks get a muted badge in the collapsed header.

### `TeamTaskCreateModal.tsx`

- Add optional `task?: TeamTask` and `currentUser: UserProfile`.
- When `task` is present:
  - prefill title / description / deadline (split ISO → `YYYY-MM-DD`) / priority / milestone
  - header “Edit Team Task”
  - submit calls `repo.updateTeamTask(task.id, patch, user)`
  - button “Save Changes”
- Create path unchanged when `task` is absent.

---

## 5. Personal task editing

### `src/data/taskEdits.ts` (new, pure)

```ts
export interface TaskEditInput {
  title: string;
  description: string;
  category: TaskCategory;
  priority: TaskPriority | '';
  startDate: string;   // '' = no explicit start
  dueDate: string;
  dueTime: string;
}

export function validateTaskEdits(
  original: SampleTask,
  input: TaskEditInput,
  now?: Date
): { isValid: boolean; errors: {...}; values: {...} };
```

Rules:

- Title required (trimmed); due date required.
- Only run `validateChronologicalDeadline` when the deadline fields changed. Demo fixtures are dated earlier than “today”, so a priority-only edit must remain valid.
- Start-date rules always checked when a start date is present:
  - not older than 7 days
  - not after the due date
- **`createdAt` is preserved**; `effectiveCreatedAt` is ignored on edit.

Tests: `src/data/taskEdits.test.ts`, including the overdue priority-only regression.

### `TaskDetailModal.tsx`

- New props: `onUpdateTask?`, `onArchive?`, `onRestore?`, `onDelete?`.
- Edit mode for every field:
  - title `Input`
  - description `textarea`
  - category select
  - priority select
  - start date
  - due date
  - due time
- All hooks above the `if (!isOpen || !task) return null` guard; reset on `[isOpen, task?.id]`.
- Read footer: `[Edit]` `[Complete/Reopen]` … `[Archive|Restore]` `[Delete]` `[Close]`
  - archived tasks hide complete/reopen
- Edit footer: `[Cancel]` … `[Save Changes]`
- Field-level errors from `validateTaskEdits`.

### `WorkspaceLayout.tsx`

- Add `handleUpdateTask`, `handleArchiveTask`, `handleRestoreTask`, `handleDeleteTask`:
  - spread-based updates; never mutate `SAMPLE_TASKS`
  - append checkpoints
  - sync `selectedTask`
  - toasts
- Shared `ConfirmDialog` driven by `taskPendingDelete`.

---

## 6. Preview persistence

- Key `vido_preview_tasks_v2`, envelope `{ version: 2, tasks }`.
- Preview initializer reads the envelope; falls back to `SAMPLE_TASKS` on missing/corrupt/wrong version.
- Persist effect writes the preview key in preview mode and `vido_tasks_<uid>` in live mode (existing behaviour).
- **Reset demo data** button in the preview banner (`WorkspaceLayout.tsx:351-380`):
  - closes any open modal
  - writes `SAMPLE_TASKS`
  - sets state to shallow clones
- Tests clear `localStorage` in `beforeEach`.

---

## 7. Row-level `…` menu

### `src/features/workspace/TaskActionsMenu.tsx` (new, feature-level because it uses `SampleTask`)

```ts
interface TaskActionsMenuProps {
  task: SampleTask;
  onArchive?: (task: SampleTask) => void;
  onRestore?: (task: SampleTask) => void;
  onDelete?: (task: SampleTask) => void;
}
```

- `…` trigger: `aria-haspopup="menu"`, `aria-expanded`, `aria-label={`Actions for ${task.title}`}`.
- `role="menu"` with `role="menuitem"` items:
  - **Archive** (non-archived) or **Restore** (archived)
  - **Delete task** (danger)
- Click calls `e.stopPropagation()` so the row/card click (open detail) never fires.
- Close on Escape, outside click, and selection; focus returns to the trigger.
- Rendered via a relatively-positioned wrapper so it is not clipped.

### Consumers

- `TaskRow.tsx`: accept `onArchive/onRestore/onDelete`; render the menu at the row’s right edge; reuse the existing checkbox `stopPropagation` pattern.
- `TaskCard.tsx`: same props; render the menu in the top-right badge cluster (ListView uses `TaskCard`, so this is required to cover ListView).
- `HomeView.tsx`: new optional props `onArchiveTask / onRestoreTask / onDeleteTask`, passed to both `TaskRow` call sites (dashboard and Tasks tab).
- `ListView.tsx`: same three props, passed to `TaskCard`.
- `WorkspaceLayout.tsx`: pass the handlers to all `HomeView` routes (`index`, `tasks`) and all `ListView` routes (`today`, `upcoming`, `needs-attention`, `completed`, `archived`).
- All routes use the **same** handlers; delete always opens the shared `ConfirmDialog` owned by `WorkspaceLayout` (single source of truth, no per-row dialogs).

### Calendar confirmation

`CalendarView.tsx`: local `pendingEventId` + `ConfirmDialog` before `onDeleteEvent`. Update `PlanningViews.test.tsx` to click through the confirmation (intentional spec change, not a weakened test).

---

## 8. Tests

| File | Coverage |
|---|---|
| `src/data/taskEdits.test.ts` (new) | all field validation; overdue priority-only edit; start > due; cleared start date; `createdAt` preserved |
| `src/features/teams/permissions.test.ts` (new) | `lead-only` vs `lead-or-assignee`, lead, assignee, unassigned, legacy default |
| `src/features/workspace/TaskActionsMenu.test.tsx` (new) | open/close, Escape, outside click, archive/restore/delete callbacks, no row navigation |
| `src/features/workspace/WorkspaceViewsAndModals.test.tsx` | modal edit save/cancel/invalid; menu-driven archive → Archived list; restore; delete confirm/cancel; deleting open task closes modal; preview persistence + reset; `localStorage.clear()` in `beforeEach` |
| `src/components/ui/ui.test.tsx` | `ConfirmDialog` confirm/cancel/Escape/tone |
| `src/features/workspace/views/PlanningViews.test.tsx` | calendar delete confirm step |
| `src/features/teams/MockTeamRepository.test.ts` | update fields; archive/restore status; delete; **both permission modes** for update/archive/delete; `updateTeamSettings` lead-only; legacy team defaults |
| `src/features/teams/TeamTaskCreateModal.test.tsx` | edit-mode prefill + update call; create path unchanged |
| `src/features/teams/TeamTaskRow.test.tsx` | manage controls visible for lead; visible for assignee in permissive mode; hidden for non-assignee member and in restrictive mode; progress controls unaffected |
| `src/features/teams/TeamSpaceView.test.tsx` | policy selector only for lead; toggling calls repo and updates header; archived filter/toggle; edit/archive/delete flows |

---

## 9. Verification

```bash
npm run typecheck
npm test
npm run build
npm run build:server
npm --prefix server run prisma:generate   # after schema change
```

`npm --prefix server run prisma:push` is required once on any dev DB before running the server.

No test may be disabled or deleted.

---

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Hook-order violations in modals | All hooks above early returns |
| Shared `SAMPLE_TASKS` mutated | Spread-only updates; shallow-clone on reset; regression test |
| Preview localStorage poisons tests | Versioned key + `localStorage.clear()` in `beforeEach` |
| Old cached teams lack `taskEditPolicy` | Optional field + `getTeamTaskEditPolicy` fallback |
| Supabase deployments missing column | Explicit migration SQL file + PR note |
| Policy bypass via direct API | Server-side check; Supabase client guard noted as defense-in-depth (RLS is authoritative) |
| Policy shown differently across layers | One shared helper + duplicated server rule + tests for both modes |
| Menu click opens the detail modal | `stopPropagation` on trigger and items; dedicated test |
| Row menu clipped in cards/rows | Relative wrapper + z-index; visual check in both `TaskRow` and `TaskCard` |
| ListView has no `TaskRow` | Menu added to `TaskCard` too |
| Team restore loses progress | Restore only flips `status`; progress/checkpoints/`completedAt` preserved |
| Prisma schema drift | `prisma:push` + `prisma:generate` in the checklist |

---

## 11. Sequencing

1. `taskEdits.ts`, `archivedAt`, `ConfirmDialog`, `TaskActionsMenu` + tests.
2. Personal editing + preview persistence + reset.
3. Personal archive/restore/delete in modal + row menu + calendar confirm + tests.
4. Team permissions helper + `Team.taskEditPolicy` across types/Prisma/Supabase SQL.
5. Team repository methods in Mock/Supabase/NestJS + server endpoints + repo tests (both modes).
6. Team UI: header policy control, row manage actions, edit modal, archived filter + tests.
7. Full verification sweep (`typecheck`, `test`, `build`, `build:server`).
