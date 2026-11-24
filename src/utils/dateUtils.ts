/**
 * Date and time utilities for ViDo deadline and chronological validation.
 */

/**
 * Returns today's date formatted as YYYY-MM-DD in local time.
 */
export function getTodayDateString(d: Date = new Date()): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Returns the date exactly 7 calendar days before d as YYYY-MM-DD in local time.
 */
export function getSevenDaysAgoDateString(d: Date = new Date()): string {
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 7);
  const year = target.getFullYear();
  const month = String(target.getMonth() + 1).padStart(2, '0');
  const day = String(target.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Returns the current time formatted as HH:mm in local time.
 */
export function getCurrentTimeString(d: Date = new Date()): string {
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Returns default future due time for a task deadline.
 * Defaults to 23:59 (end of the selected day).
 */
export function getDefaultDueTime(): string {
  return '23:59';
}

const DATE_STRING_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_STRING_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** True when value is a real calendar date formatted as YYYY-MM-DD. */
export function isValidDateString(value: string): boolean {
  if (!DATE_STRING_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(year, month - 1, day);
  return (
    parsed.getFullYear() === year &&
    parsed.getMonth() === month - 1 &&
    parsed.getDate() === day
  );
}

/** True when value is a 24-hour time formatted as HH:mm. */
function isValidTimeString(value: string): boolean {
  return TIME_STRING_PATTERN.test(value);
}

export interface ChronologicalValidationOptions {
  dueDate: string;
  dueTime?: string;
  startDate?: string;
  isBackdated?: boolean;
  startTime?: string;
  now?: Date;
  /**
   * Editing an existing task may legitimately keep an overdue deadline.
   * When true, only the 7-day window and the same-day "deadline must be after
   * now" checks are relaxed. Deadline >= task start date and same-day ordering
   * against an explicit start time remain enforced.
   */
  allowPastDeadline?: boolean;
}

export interface ChronologicalValidationResult {
  isValid: boolean;
  dateError?: string;
  timeError?: string;
  startError?: string;
  generalError?: string;
  effectiveStartDate?: string;
  effectiveCreatedAt: string;
  effectiveDueDate: string;
  effectiveDueTime: string;
}

/**
 * Validates chronological integrity of task start time and deadline:
 * 1. Default creation time is Date.now() unless explicitly provided via optional Start Date.
 * 2. Backdating is allowed up to 7 calendar days in the past (fallback grace period); earlier dates are blocked.
 * 3. Start date can be in the future (for planning ahead) or up to 7 days in the past.
 * 4. Deadline date must always fall on or after the start date (deadline >= startDate), including edit mode.
 *    - Same-Day Tasks: If start date and deadline date are the same, deadline can be set to any valid time today (or defaults to 11:59 PM if left blank).
 *    - Future dates after start date allow any valid time of day.
 * 5. Same-day deadlines must be later than an explicit start time. Deadlines in the past relative to now are rejected only during creation.
 * 6. Start/due dates and times must be real, correctly formatted values.
 * 7. Dates older than 7 days in the past are blocked during creation; edit mode may retain them.
 */
export function validateChronologicalDeadline(
  options: ChronologicalValidationOptions
): ChronologicalValidationResult {
  const now = options.now || new Date();
  const todayStr = getTodayDateString(now);
  const currentTimeStr = getCurrentTimeString(now);
  const sevenDaysAgoStr = getSevenDaysAgoDateString(now);

  let effectiveStartDate = todayStr;
  let effectiveStartTime = currentTimeStr;
  let effectiveCreatedAt = now.toISOString();

  const rawStartDate = options.startDate?.trim();
  const rawStartTime = options.startTime?.trim();

  if (rawStartDate && !isValidDateString(rawStartDate)) {
    return {
      isValid: false,
      startError: 'Start date must be a valid date (YYYY-MM-DD).',
      generalError: 'Start date must be a valid date (YYYY-MM-DD).',
      effectiveStartDate: rawStartDate,
      effectiveCreatedAt,
      effectiveDueDate: options.dueDate,
      effectiveDueTime: options.dueTime || '23:59',
    };
  }

  if (rawStartTime && (rawStartDate || options.isBackdated) && !isValidTimeString(rawStartTime)) {
    return {
      isValid: false,
      startError: 'Start time must be a valid time (HH:mm).',
      generalError: 'Start time must be a valid time (HH:mm).',
      effectiveStartDate,
      effectiveCreatedAt,
      effectiveDueDate: options.dueDate,
      effectiveDueTime: options.dueTime || '23:59',
    };
  }

  // 1. Validate Start Date if provided (or if legacy isBackdated flag is true)
  if (rawStartDate) {
    if (rawStartDate < sevenDaysAgoStr && !options.allowPastDeadline) {
      return {
        isValid: false,
        startError: 'Start date cannot be older than 7 days.',
        generalError: 'Start date cannot be older than 7 days. Date is beyond the 7-day logging window.',
        effectiveStartDate: rawStartDate,
        effectiveCreatedAt,
        effectiveDueDate: options.dueDate,
        effectiveDueTime: options.dueTime || '23:59',
      };
    }

    effectiveStartDate = rawStartDate;
    effectiveStartTime = rawStartTime || '12:00';

    const parsedStart = new Date(`${rawStartDate}T${effectiveStartTime}:00`);
    effectiveCreatedAt = isNaN(parsedStart.getTime()) ? now.toISOString() : parsedStart.toISOString();
  } else if (options.isBackdated) {
    // Backwards-compatibility fallback when isBackdated is explicitly set but startDate was not
    effectiveStartDate = todayStr;
    effectiveStartTime = rawStartTime || currentTimeStr;
  }

  // 2. Validate Target Due Date
  const rawDueDate = options.dueDate?.trim();
  if (!rawDueDate) {
    return {
      isValid: false,
      dateError: 'Target due date is required.',
      generalError: 'Please provide a target due date.',
      effectiveStartDate,
      effectiveCreatedAt,
      effectiveDueDate: '',
      effectiveDueTime: '23:59',
    };
  }

  if (!isValidDateString(rawDueDate)) {
    return {
      isValid: false,
      dateError: 'Target due date must be a valid date (YYYY-MM-DD).',
      generalError: 'Please provide a valid target due date.',
      effectiveStartDate,
      effectiveCreatedAt,
      effectiveDueDate: rawDueDate,
      effectiveDueTime: '23:59',
    };
  }

  // Default deadline time to 11:59 PM (23:59) if omitted
  const rawDueTime = options.dueTime?.trim();
  if (rawDueTime && !isValidTimeString(rawDueTime)) {
    return {
      isValid: false,
      timeError: 'Due time must be a valid time (HH:mm).',
      generalError: 'Please provide a valid due time (HH:mm).',
      effectiveStartDate,
      effectiveCreatedAt,
      effectiveDueDate: rawDueDate,
      effectiveDueTime: rawDueTime,
    };
  }

  // Check 7-day boundary for deadline (existing overdue tasks remain editable)
  if (rawDueDate < sevenDaysAgoStr && !options.allowPastDeadline) {
    return {
      isValid: false,
      dateError: 'Date is beyond the 7-day logging window.',
      generalError: 'Date is beyond the 7-day logging window. Deadlines cannot be set earlier than the 7-day window.',
      effectiveStartDate,
      effectiveCreatedAt,
      effectiveDueDate: rawDueDate,
      effectiveDueTime: '23:59',
    };
  }

  const effectiveDueTime = rawDueTime ? rawDueTime : '23:59';
  const effectiveDueDate = rawDueDate;

  // 3. Chronological check: deadline must be on or after start date.
  // This stays enforced in edit mode; editing only relaxes the 7-day window
  // and the now-relative same-day check below.
  if (effectiveDueDate < effectiveStartDate) {
    return {
      isValid: false,
      dateError: 'Deadline date must be on or after start date.',
      generalError: 'Deadline date must be on or after start date.',
      effectiveStartDate,
      effectiveCreatedAt,
      effectiveDueDate,
      effectiveDueTime,
    };
  }

  if (effectiveDueDate === effectiveStartDate) {
    // A same-day deadline that is already in the past is rejected only during
    // creation. Editing may preserve an overdue deadline.
    if (
      !options.allowPastDeadline &&
      effectiveStartDate === todayStr &&
      effectiveDueTime <= effectiveStartTime
    ) {
      const timeError = `Deadline time must be after the start time (current time is ${effectiveStartTime}).`;
      return {
        isValid: false,
        timeError,
        generalError: 'Deadline must be later than the start time.',
        effectiveStartDate,
        effectiveCreatedAt,
        effectiveDueDate,
        effectiveDueTime,
      };
    }

    // Same-day ordering against an explicit start time is always enforced.
    if (rawStartDate && rawStartTime && effectiveDueTime <= rawStartTime) {
      return {
        isValid: false,
        timeError: 'Deadline must be later than the start time.',
        generalError: 'Deadline must be later than the start time.',
        effectiveStartDate,
        effectiveCreatedAt,
        effectiveDueDate,
        effectiveDueTime,
      };
    }
  }

  return {
    isValid: true,
    effectiveStartDate,
    effectiveCreatedAt,
    effectiveDueDate,
    effectiveDueTime,
  };
}

/**
 * Legacy / convenience wrapper for simple date + time validation
 */
export function validateDeadline(
  selectedDate: string,
  selectedTime?: string,
  now: Date = new Date()
) {
  return validateChronologicalDeadline({
    dueDate: selectedDate,
    dueTime: selectedTime,
    isBackdated: false,
    now,
  });
}

/**
 * Formats a date for the top bar badge, e.g. "Tuesday, 17 Nov 2026" or "Sunday, 22 Nov 2026"
 */
export function formatTopBarDate(d: Date = new Date()): string {
  const weekday = d.toLocaleDateString('en-US', { weekday: 'long' });
  const day = d.getDate();
  const month = d.toLocaleDateString('en-US', { month: 'short' });
  const year = d.getFullYear();
  return `${weekday}, ${day} ${month} ${year}`;
}
