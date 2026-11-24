import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { SAMPLE_TASKS, type SampleTask } from '../../data/sampleTasks';
import { TaskCreateModal } from './TaskCreateModal';
import { TaskDetailModal } from './TaskDetailModal';
import { WorkspaceLayout } from './WorkspaceLayout';

// Authenticated workspace mode for this file: authenticated persistence tests
// exercise the personal workspace without touching Firebase or the network.
vi.mock('../auth', () => ({
  useAuth: () => ({
    user: {
      uid: 'test-user-uid',
      displayName: 'Test User',
      email: 'test@vido.app',
      photoURL: null,
    },
    loading: false,
    authMode: 'emulator',
    signInWithGoogle: vi.fn(),
    signOut: vi.fn(),
  }),
}));

vi.mock('../teams/teamRepository', () => ({
  getTeamRepository: () => ({
    getTeams: vi.fn().mockResolvedValue([]),
    subscribeToInvitations: vi.fn(() => () => undefined),
    respondToInvitation: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../../lib/calendarStore', () => ({
  subscribeCalendarEvents: (_uid: string, onNext: (events: unknown[]) => void) => {
    onNext([]);
    return () => undefined;
  },
  createCalendarEvent: vi.fn().mockResolvedValue(undefined),
  deleteCalendarEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/settingsStore', () => ({
  subscribePlanningTargets: (
    _uid: string,
    onNext: (targets: { weekly: number; monthly: number }) => void
  ) => {
    onNext({ weekly: 10, monthly: 40 });
    return () => undefined;
  },
  updatePlanningTargets: vi.fn().mockResolvedValue(undefined),
}));

const buildTask = (overrides: Partial<SampleTask> = {}): SampleTask => ({
  id: 'task-editable-1',
  title: 'Original Task Title',
  description: 'Original task description',
  startDate: '2026-11-10',
  dueDate: '2026-12-01',
  dueTime: '14:00',
  priority: 'medium',
  state: 'active',
  category: 'personal',
  createdAt: '2026-11-10T09:00:00Z',
  checkpoints: [
    {
      id: 'cp-original',
      timestamp: '2026-11-10T09:00:00Z',
      note: 'Task initialized in workspace.',
    },
  ],
  ...overrides,
});

describe('Task editing', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('TaskCreateModal in edit mode', () => {
    it('prepopulates all five editable fields and uses edit labels', () => {
      const task = buildTask({
        title: 'Prepare Quarterly Report',
        description: 'Collect figures from finance.',
        priority: 'high',
        dueDate: '2026-12-15',
        dueTime: '09:30',
      });

      render(
        <TaskCreateModal isOpen={true} task={task} onClose={vi.fn()} onUpdateTask={vi.fn()} />
      );

      expect(screen.getByRole('heading', { name: /edit task/i })).toBeInTheDocument();
      expect(screen.getByLabelText(/task title \*/i)).toHaveValue('Prepare Quarterly Report');
      expect(screen.getByPlaceholderText(/add key context/i)).toHaveValue(
        'Collect figures from finance.'
      );
      expect(screen.getByRole('combobox')).toHaveValue('high');
      expect(screen.getByLabelText(/target due date \*/i)).toHaveValue('2026-12-15');
      expect(screen.getByLabelText(/due time \(optional\)/i)).toHaveValue('09:30');
      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();

      // Start date and category are outside the editable scope.
      expect(screen.queryByLabelText(/start date \(optional\)/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/^category$/i)).not.toBeInTheDocument();
    });

    it('saves all five editable fields while preserving identity, state and metadata', () => {
      const task = buildTask({
        state: 'completed',
        completedAt: '2026-11-20T12:00:00Z',
        isArchived: false,
      });
      const handleUpdate = vi.fn();
      const handleClose = vi.fn();

      render(
        <TaskCreateModal
          isOpen={true}
          task={task}
          onClose={handleClose}
          onUpdateTask={handleUpdate}
        />
      );

      fireEvent.change(screen.getByLabelText(/task title \*/i), {
        target: { value: 'Updated Task Title' },
      });
      fireEvent.change(screen.getByPlaceholderText(/add key context/i), {
        target: { value: 'Updated description text' },
      });
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'low' } });
      fireEvent.change(screen.getByLabelText(/target due date \*/i), {
        target: { value: '2026-12-20' },
      });
      fireEvent.change(screen.getByLabelText(/due time \(optional\)/i), {
        target: { value: '16:45' },
      });

      const saveButton = screen.getByRole('button', { name: /save changes/i });
      expect(saveButton).not.toBeDisabled();
      fireEvent.click(saveButton);

      expect(handleUpdate).toHaveBeenCalledTimes(1);
      expect(handleUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          id: task.id,
          title: 'Updated Task Title',
          description: 'Updated description text',
          priority: 'low',
          dueDate: '2026-12-20',
          dueTime: '16:45',
          // Untouched task data is preserved.
          startDate: task.startDate,
          category: task.category,
          createdAt: task.createdAt,
          state: task.state,
          completedAt: task.completedAt,
          isArchived: task.isArchived,
          checkpoints: task.checkpoints,
        })
      );
      expect(handleClose).toHaveBeenCalledTimes(1);
    });

    it('cancels without updating or modifying the task', () => {
      const task = buildTask();
      const handleUpdate = vi.fn();
      const handleClose = vi.fn();

      render(
        <TaskCreateModal
          isOpen={true}
          task={task}
          onClose={handleClose}
          onUpdateTask={handleUpdate}
        />
      );

      fireEvent.change(screen.getByLabelText(/task title \*/i), {
        target: { value: 'Discarded Title' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

      expect(handleUpdate).not.toHaveBeenCalled();
      expect(handleClose).toHaveBeenCalledTimes(1);
      expect(task.title).toBe('Original Task Title');
    });

    it('allows editing an overdue task without changing its deadline', () => {
      const overdueTask = buildTask({
        title: 'Overdue Personal Task',
        startDate: '2019-12-01',
        dueDate: '2020-01-01',
        dueTime: '09:00',
        priority: 'medium',
      });
      const handleUpdate = vi.fn();

      render(
        <TaskCreateModal
          isOpen={true}
          task={overdueTask}
          onClose={vi.fn()}
          onUpdateTask={handleUpdate}
        />
      );

      fireEvent.change(screen.getByLabelText(/task title \*/i), {
        target: { value: 'Overdue Task Renamed' },
      });

      const saveButton = screen.getByRole('button', { name: /save changes/i });
      expect(saveButton).not.toBeDisabled();
      fireEvent.click(saveButton);

      expect(handleUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          id: overdueTask.id,
          title: 'Overdue Task Renamed',
          startDate: '2019-12-01',
          dueDate: '2020-01-01',
          dueTime: '09:00',
          state: 'active',
        })
      );
    });

    it('allows editing an overdue task with no explicit start date', () => {
      const overdueTask = buildTask({
        startDate: undefined,
        createdAt: '2025-01-01T09:00:00Z',
        dueDate: '2025-01-15',
        dueTime: '09:00',
      });
      const handleUpdate = vi.fn();

      render(
        <TaskCreateModal
          isOpen={true}
          task={overdueTask}
          onClose={vi.fn()}
          onUpdateTask={handleUpdate}
        />
      );

      fireEvent.change(screen.getByLabelText(/task title \*/i), {
        target: { value: 'Overdue Task Without Start Date' },
      });

      const saveButton = screen.getByRole('button', { name: /save changes/i });
      expect(saveButton).not.toBeDisabled();
      fireEvent.click(saveButton);

      expect(handleUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          id: overdueTask.id,
          dueDate: '2025-01-15',
          dueTime: '09:00',
          state: 'active',
        })
      );
    });

    it('derives the edit start date from createdAt when task.startDate is invalid', () => {
      const task = buildTask({
        startDate: 'not-a-date',
        createdAt: '2025-01-01T09:00:00Z',
        dueDate: '2025-01-15',
        dueTime: '09:00',
      });
      const handleUpdate = vi.fn();

      render(
        <TaskCreateModal
          isOpen={true}
          task={task}
          onClose={vi.fn()}
          onUpdateTask={handleUpdate}
        />
      );

      fireEvent.change(screen.getByLabelText(/task title \*/i), {
        target: { value: 'Invalid Start Date Fallback' },
      });

      // The overdue deadline would be rejected if today's date were
      // substituted for the invalid start date.
      const saveButton = screen.getByRole('button', { name: /save changes/i });
      expect(saveButton).not.toBeDisabled();
      fireEvent.click(saveButton);

      expect(handleUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          id: task.id,
          dueDate: '2025-01-15',
          startDate: 'not-a-date',
          state: 'active',
        })
      );
    });

    it('blocks editing when both task.startDate and createdAt are invalid', () => {
      const task = buildTask({
        startDate: '2026-02-30',
        createdAt: 'not-a-timestamp',
        dueDate: '2025-01-15',
      });
      const handleUpdate = vi.fn();

      render(
        <TaskCreateModal
          isOpen={true}
          task={task}
          onClose={vi.fn()}
          onUpdateTask={handleUpdate}
        />
      );

      // An explicit error is shown instead of silently defaulting to today.
      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
      expect(screen.getByRole('alert')).toHaveTextContent(
        /cannot be edited because its start date and creation date are invalid/i
      );

      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
      expect(handleUpdate).not.toHaveBeenCalled();
    });

    it('rejects a due date earlier than the task start date while editing', () => {
      const task = buildTask({ startDate: '2026-11-10', dueDate: '2026-11-20' });
      const handleUpdate = vi.fn();

      render(
        <TaskCreateModal
          isOpen={true}
          task={task}
          onClose={vi.fn()}
          onUpdateTask={handleUpdate}
        />
      );

      fireEvent.change(screen.getByLabelText(/target due date \*/i), {
        target: { value: '2026-11-09' },
      });

      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
      expect(screen.getByRole('alert')).toHaveTextContent(
        /deadline date must be on or after start date/i
      );
      expect(handleUpdate).not.toHaveBeenCalled();
    });

    it('keeps an absent optional due time absent when it is not changed', () => {
      const task = buildTask({ dueTime: undefined });
      const handleUpdate = vi.fn();

      render(
        <TaskCreateModal
          isOpen={true}
          task={task}
          onClose={vi.fn()}
          onUpdateTask={handleUpdate}
        />
      );

      // The form still displays the end-of-day default.
      expect(screen.getByLabelText(/due time \(optional\)/i)).toHaveValue('23:59');

      fireEvent.change(screen.getByLabelText(/task title \*/i), {
        target: { value: 'Renamed Without Time' },
      });
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

      expect(handleUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          id: task.id,
          title: 'Renamed Without Time',
          dueTime: undefined,
        })
      );
    });

    it('saves a due time that the user sets explicitly', () => {
      const task = buildTask({ dueTime: undefined });
      const handleUpdate = vi.fn();

      render(
        <TaskCreateModal
          isOpen={true}
          task={task}
          onClose={vi.fn()}
          onUpdateTask={handleUpdate}
        />
      );

      fireEvent.change(screen.getByLabelText(/due time \(optional\)/i), {
        target: { value: '07:45' },
      });
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

      expect(handleUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ id: task.id, dueTime: '07:45' })
      );
    });

    it('rejects an empty title and a missing due date', () => {
      const handleUpdate = vi.fn();
      const task = buildTask();

      render(
        <TaskCreateModal
          isOpen={true}
          task={task}
          onClose={vi.fn()}
          onUpdateTask={handleUpdate}
        />
      );

      fireEvent.change(screen.getByLabelText(/task title \*/i), { target: { value: '   ' } });
      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();

      fireEvent.change(screen.getByLabelText(/task title \*/i), { target: { value: 'Valid' } });
      fireEvent.change(screen.getByLabelText(/target due date \*/i), { target: { value: '' } });
      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();

      expect(handleUpdate).not.toHaveBeenCalled();
    });
  });

  describe('TaskDetailModal edit action', () => {
    it('offers Edit Task for active tasks and passes the task to the workspace flow', () => {
      const activeTask = SAMPLE_TASKS.find((task) => task.state === 'active')!;
      const handleEdit = vi.fn();

      render(
        <TaskDetailModal
          task={activeTask}
          isOpen={true}
          onClose={vi.fn()}
          onEditTask={handleEdit}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /edit task/i }));
      expect(handleEdit).toHaveBeenCalledWith(activeTask);
    });

    it('offers Edit Task for completed tasks', () => {
      const completedTask = SAMPLE_TASKS.find(
        (task) => task.state === 'completed' && !task.isArchived
      )!;
      const handleEdit = vi.fn();

      render(
        <TaskDetailModal
          task={completedTask}
          isOpen={true}
          onClose={vi.fn()}
          onEditTask={handleEdit}
        />
      );

      expect(screen.getByRole('button', { name: /edit task/i })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /edit task/i }));
      expect(handleEdit).toHaveBeenCalledWith(completedTask);
    });

    it('does not offer Edit Task for archived tasks', () => {
      const archivedTask = SAMPLE_TASKS.find((task) => task.isArchived)!;
      const handleEdit = vi.fn();

      render(
        <TaskDetailModal
          task={archivedTask}
          isOpen={true}
          onClose={vi.fn()}
          onEditTask={handleEdit}
        />
      );

      expect(screen.queryByRole('button', { name: /edit task/i })).not.toBeInTheDocument();
    });
  });

  describe('Workspace integration', () => {
    it('edits a task in preview mode using React state only', async () => {
      render(
        <MemoryRouter initialEntries={['/preview/tasks']}>
          <Routes>
            <Route path="/preview/*" element={<WorkspaceLayout />} />
          </Routes>
        </MemoryRouter>
      );

      fireEvent.click(
        screen.getByLabelText(/task: submit vehicle registration renewal/i)
      );

      expect(
        screen.getByRole('heading', { name: /submit vehicle registration renewal/i })
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /edit task/i }));

      expect(screen.getByRole('heading', { name: /edit task/i })).toBeInTheDocument();
      const titleInput = screen.getByLabelText(/task title \*/i);
      expect(titleInput).toHaveValue('Submit Vehicle Registration Renewal');

      fireEvent.change(titleInput, {
        target: { value: 'Submit Updated Vehicle Registration' },
      });
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'high' } });
      fireEvent.change(screen.getByLabelText(/target due date \*/i), {
        target: { value: '2026-12-10' },
      });
      fireEvent.change(screen.getByLabelText(/due time \(optional\)/i), {
        target: { value: '10:15' },
      });

      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(screen.getByText('Submit Updated Vehicle Registration')).toBeInTheDocument();
      });
      expect(
        screen.getByText(/task "submit updated vehicle registration" updated/i)
      ).toBeInTheDocument();
      // Preview mode never writes to the personal task localStorage key.
      expect(localStorage.getItem('vido_tasks_test-user-uid')).toBeNull();
    });

    it('persists edits for an authenticated personal workspace to UID localStorage', async () => {
      const persistedTask = buildTask({
        id: 'task-persist-1',
        title: 'Persisted Local Task',
        dueDate: '2030-01-01',
        dueTime: '12:00',
        priority: 'low',
      });
      localStorage.setItem('vido_tasks_test-user-uid', JSON.stringify([persistedTask]));

      render(
        <MemoryRouter initialEntries={['/workspace/tasks']}>
          <Routes>
            <Route path="/workspace/*" element={<WorkspaceLayout />} />
          </Routes>
        </MemoryRouter>
      );

      fireEvent.click(screen.getByLabelText(/task: persisted local task/i));
      fireEvent.click(screen.getByRole('button', { name: /edit task/i }));

      fireEvent.change(screen.getByLabelText(/task title \*/i), {
        target: { value: 'Persisted Edited Task' },
      });
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'high' } });
      fireEvent.change(screen.getByLabelText(/target due date \*/i), {
        target: { value: '2030-02-02' },
      });
      fireEvent.change(screen.getByLabelText(/due time \(optional\)/i), {
        target: { value: '18:00' },
      });

      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        const stored = JSON.parse(
          localStorage.getItem('vido_tasks_test-user-uid') || '[]'
        ) as SampleTask[];
        expect(stored).toHaveLength(1);
        expect(stored[0]).toEqual(
          expect.objectContaining({
            id: persistedTask.id,
            title: 'Persisted Edited Task',
            priority: 'high',
            dueDate: '2030-02-02',
            dueTime: '18:00',
            state: 'active',
            createdAt: persistedTask.createdAt,
            checkpoints: persistedTask.checkpoints,
          })
        );
      });
    });
  });
});
