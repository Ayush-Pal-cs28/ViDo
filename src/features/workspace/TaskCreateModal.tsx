import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Button, Input } from '../../components/ui';
import { SampleTask } from '../../data/sampleTasks';
import { X, Tag, CheckCircle2, AlertCircle } from 'lucide-react';
import {
  getTodayDateString,
  getSevenDaysAgoDateString,
  getCurrentTimeString,
  getDefaultDueTime,
  isValidDateString,
  validateChronologicalDeadline,
  type ChronologicalValidationResult,
} from '../../utils/dateUtils';

/**
 * Editing keeps the task's original start date. Tasks created without an
 * explicit start date use their creation date as the implicit start date,
 * matching the task model, so genuinely overdue tasks remain editable while
 * deadline-on-or-after-start-date validation stays enforced.
 *
 * Returns null when neither the explicit start date nor the creation timestamp
 * is valid, so callers can surface the invalid data instead of substituting
 * today's date.
 */
function resolveTaskStartDate(task: SampleTask): string | null {
  const explicitStartDate = task.startDate?.trim();
  if (explicitStartDate && isValidDateString(explicitStartDate)) {
    return explicitStartDate;
  }

  const createdAt = new Date(task.createdAt);
  return Number.isNaN(createdAt.getTime()) ? null : getTodayDateString(createdAt);
}

const INVALID_TASK_START_DATE_MESSAGE =
  'This task cannot be edited because its start date and creation date are invalid.';

interface TaskCreateModalBaseProps {
  isOpen: boolean;
  onClose: () => void;
  onCreateTask?: (task: SampleTask) => void;
  initialStartDate?: string;
  initialDueDate?: string;
  initialDueTime?: string;
}

interface CreateModeProps extends TaskCreateModalBaseProps {
  /** Create mode does not edit an existing task. */
  task?: undefined;
  onUpdateTask?: undefined;
}

interface EditModeProps extends TaskCreateModalBaseProps {
  /** Provide an existing task to open this same form in edit mode. */
  task: SampleTask;
  /** Required so edit mode can never save without an update callback. */
  onUpdateTask: (task: SampleTask) => void;
}

interface InactiveEditModeProps extends TaskCreateModalBaseProps {
  /** The edit shell may remain mounted while no task is selected. */
  task: null;
  onUpdateTask: (task: SampleTask) => void;
}

export type TaskCreateModalProps =
  | CreateModeProps
  | EditModeProps
  | InactiveEditModeProps;

export const TaskCreateModal: React.FC<TaskCreateModalProps> = ({
  isOpen,
  onClose,
  onCreateTask,
  onUpdateTask,
  task,
  initialStartDate,
  initialDueDate,
  initialDueTime,
}) => {
  const isEditMode = Boolean(task);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startDate, setStartDate] = useState(() => initialStartDate || '');
  const [dueDate, setDueDate] = useState(() => initialDueDate || getTodayDateString());
  const [dueTime, setDueTime] = useState(() => initialDueTime ?? getDefaultDueTime());
  const [priority, setPriority] = useState<'high' | 'medium' | 'low' | ''>('medium');
  const [category, setCategory] = useState<'personal' | 'home' | 'work'>('personal');
  const [submittedNotice, setSubmittedNotice] = useState(false);
  const [startDateDataError, setStartDateDataError] = useState<string | null>(null);

  const titleInputRef = useRef<HTMLInputElement>(null);
  const previousTaskIdRef = useRef<string | null>(null);

  const todayStr = getTodayDateString();
  const sevenDaysAgoStr = getSevenDaysAgoDateString();
  const currentTimeStr = getCurrentTimeString();

  // Compute live validation using useMemo
  const validation = useMemo<ChronologicalValidationResult>(() => {
    if (isEditMode && startDateDataError) {
      return {
        isValid: false,
        startError: startDateDataError,
        generalError: startDateDataError,
        effectiveCreatedAt: task?.createdAt ?? '',
        effectiveDueDate: dueDate,
        effectiveDueTime: dueTime || getDefaultDueTime(),
      };
    }

    return validateChronologicalDeadline({
      startDate,
      dueDate,
      dueTime,
      // Editing may retain a valid overdue deadline for an existing task.
      // Creation validation remains strict.
      allowPastDeadline: isEditMode,
    });
  }, [startDate, dueDate, dueTime, isEditMode, startDateDataError, task]);

  const missingUpdateHandler = isEditMode && !onUpdateTask;
  const isFormValid = Boolean(title.trim()) && validation.isValid && !missingUpdateHandler;

  const isSelectedDateToday = dueDate === todayStr;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
      setSubmittedNotice(false);

      const today = getTodayDateString();
      if (!dueDate) {
        setDueDate(today);
      }
      setTimeout(() => titleInputRef.current?.focus(), 50);
    }
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Prepopulate the five editable fields when opening an existing task.
  // When returning to create mode, clear any edit values so creation
  // behaviour stays unchanged.
  useEffect(() => {
    if (!isOpen) return;

    if (task) {
      const resolvedStartDate = resolveTaskStartDate(task);
      setTitle(task.title);
      setDescription(task.description || '');
      setStartDate(resolvedStartDate ?? '');
      setStartDateDataError(resolvedStartDate ? null : INVALID_TASK_START_DATE_MESSAGE);
      setDueDate(task.dueDate);
      setDueTime(task.dueTime ?? getDefaultDueTime());
      setPriority(task.priority ?? '');
      setCategory(task.category);
      previousTaskIdRef.current = task.id;
      return;
    }

    if (previousTaskIdRef.current !== null) {
      setTitle('');
      setDescription('');
      setStartDate('');
      setStartDateDataError(null);
      setDueDate(getTodayDateString());
      setDueTime(getDefaultDueTime());
      setPriority('medium');
      setCategory('personal');
      previousTaskIdRef.current = null;
    }
  }, [isOpen, task]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !validation.isValid) return;

    if (isEditMode && task) {
      // Defensive guard for untyped/runtime callers: never close the modal
      // without persisting the edit.
      if (!onUpdateTask) return;

      // 23:59 is only the form's display default. If the user never changed
      // the time, keep the task's original optional value (undefined stays
      // undefined) instead of materializing an explicit 23:59.
      const displayedOriginalDueTime = task.dueTime ?? getDefaultDueTime();
      const dueTimeUnchanged = dueTime === displayedOriginalDueTime;

      // Update only the five editable fields; preserve identity, state,
      // timestamps, checkpoints, archive metadata and other task data.
      const updatedTask: SampleTask = {
        ...task,
        title: title.trim(),
        description: description.trim() || undefined,
        dueDate: validation.effectiveDueDate,
        dueTime: dueTimeUnchanged ? task.dueTime : validation.effectiveDueTime,
        priority: (priority as 'high' | 'medium' | 'low') || undefined,
      };

      onUpdateTask(updatedTask);
      onClose();
      return;
    }

    const newTask: SampleTask = {
      id: `task-${Date.now()}`,
      title: title.trim(),
      description: description.trim() || undefined,
      startDate: startDate.trim() || undefined,
      dueDate: validation.effectiveDueDate,
      dueTime: validation.effectiveDueTime,
      priority: (priority as 'high' | 'medium' | 'low') || undefined,
      state: 'active',
      category,
      createdAt: validation.effectiveCreatedAt,
      checkpoints: [
        {
          id: `cp-${Date.now()}`,
          timestamp: validation.effectiveCreatedAt,
          note: startDate.trim()
            ? `Task initialized in workspace (started on ${startDate.trim()}).`
            : 'Task initialized in workspace.',
        },
      ],
    };

    setSubmittedNotice(true);
    onCreateTask?.(newTask);

    // Reset inputs
    setTitle('');
    setDescription('');
    setStartDate('');
    setStartDateDataError(null);
    setDueDate(getTodayDateString());
    setDueTime(getDefaultDueTime());
    setPriority('medium');
    setCategory('personal');

    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-task-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-[var(--surface)] border border-[var(--line)] rounded-2xl p-6 shadow-2xl relative max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          aria-label={isEditMode ? 'Close edit task modal' : 'Close create task modal'}
          className="absolute top-5 right-5 text-[var(--muted)] hover:text-[var(--ink)] p-1 rounded-lg hover:bg-[var(--canvas)] transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        <h2 id="create-task-title" className="text-xl font-bold text-[var(--ink)]">
          {isEditMode ? 'Edit Task' : 'Create New Task'}
        </h2>
        <p className="text-xs text-[var(--muted)] mt-1 mb-5">
          {isEditMode
            ? 'Update the title, description, priority, due date, and due time for this task.'
            : 'Define exact deadlines and chronological ownership for your next responsibility.'}
        </p>

        {submittedNotice && (
          <div className="mb-5 p-3.5 rounded-xl bg-[var(--green-soft)] border border-[var(--green)]/30 text-xs text-[var(--green)] flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <p className="text-xs font-semibold leading-relaxed">
              Task successfully saved to your workspace.
            </p>
          </div>
        )}

        {validation.generalError && (
          <div
            role="alert"
            className="mb-5 p-3.5 rounded-xl bg-[var(--red-soft)] border border-[var(--red)]/30 text-xs text-[var(--red)] flex items-start gap-2.5 animate-in fade-in duration-150"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Invalid Chronological Combination</p>
              <p className="mt-0.5 text-[11px] leading-relaxed opacity-90">{validation.generalError}</p>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            ref={titleInputRef}
            label="Task Title *"
            required
            placeholder="e.g., Finalize customer onboarding slide deck"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />

          <div>
            <label className="block text-xs font-semibold text-[var(--muted)] mb-1.5">
              Description (Optional)
            </label>
            <textarea
              rows={3}
              placeholder="Add key context, requirements, or links..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3.5 py-2 text-sm bg-[var(--surface)] text-[var(--ink)] placeholder-[var(--faint)] border border-[var(--line)] rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-1 resize-none"
            />
          </div>

          {/* Date & Time Selection */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {!isEditMode && (
              <Input
                label="Start Date (Optional)"
                type="date"
                min={sevenDaysAgoStr}
                value={startDate}
                error={validation.startError}
                helperText="Defaults to today if omitted (max 7 days in past)"
                onChange={(e) => setStartDate(e.target.value)}
              />
            )}

            <Input
              label="Target Due Date *"
              type="date"
              required
              min={isEditMode ? undefined : startDate || sevenDaysAgoStr}
              value={dueDate}
              error={validation.dateError}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label="Due Time (Optional)"
              type="time"
              value={dueTime}
              error={validation.timeError}
              helperText={
                isEditMode
                  ? 'Defaults to 11:59 PM if omitted'
                  : isSelectedDateToday && !startDate
                  ? `Must be after ${currentTimeStr} (defaults to 11:59 PM if omitted)`
                  : 'Defaults to 11:59 PM if omitted'
              }
              onChange={(e) => setDueTime(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
            {!isEditMode && (
              <div>
                <label className="block text-xs font-semibold text-[var(--muted)] mb-1.5 flex items-center gap-1">
                  <Tag className="w-3 h-3 text-[var(--faint)]" /> Category
                </label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as any)}
                  className="w-full px-3 py-2 text-xs bg-[var(--surface)] text-[var(--ink)] border border-[var(--line)] rounded-lg focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                >
                  <option value="personal">Personal</option>
                  <option value="home">Household / Living</option>
                  <option value="work">Work / Professional</option>
                </select>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-[var(--muted)] mb-1.5">
                Priority Level
              </label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as any)}
                className="w-full px-3 py-2 text-xs bg-[var(--surface)] text-[var(--ink)] border border-[var(--line)] rounded-lg focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
              >
                <option value="">None</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
          </div>

          <div className="pt-4 border-t border-[var(--line)] flex items-center justify-end gap-3">
            <Button type="button" variant="secondary" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={!isFormValid}
              aria-label={isEditMode ? 'Save Changes' : 'Create Task'}
            >
              {isEditMode ? 'Save Changes' : 'Create Task'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};
