import { ApiError } from './errors';
import type { SubmissionFields, SubmissionValue } from './types';

/**
 * A form's declared shape, and the check of a submission against it.
 *
 * This is the difference between a relay and a validator. Without a
 * declaration the endpoint cannot know a form's field names, which are
 * required, or what a plausible value looks like -- so it forwards whatever
 * arrives. With one it can refuse a submission on its merits rather than on
 * its fingerprints, which is the only kind of refusal that stays true as the
 * senders adapt.
 *
 * Deliberately not a rules engine. Everything here is a property of a single
 * field. Constraints that span fields ("checkout must follow checkin",
 * "adults + children within the occupancy cap") are a separate feature with a
 * separate expression language, and folding them in here would turn a schema
 * into a scripting host.
 */

export const FIELD_TYPES = [
  'text',
  'email',
  'tel',
  'url',
  'integer',
  'number',
  'date',
  'time',
  'datetime',
  'boolean',
  'choice',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export interface FieldSpec {
  type: FieldType;
  required?: boolean;
  min?: number;
  max?: number;
  min_length?: number;
  max_length?: number;
  pattern?: string;
  options?: string[];
  /** Allows a repeated field (checkbox groups, multi-selects). */
  multiple?: boolean;
}

export interface FormSchema {
  /** Refuse fields the schema does not declare. On unless explicitly disabled. */
  strict: boolean;
  fields: Record<string, FieldSpec>;
}

export interface FieldError {
  field: string;
  code: string;
  message: string;
}

const MAX_SCHEMA_FIELDS = 100;
const MAX_OPTIONS = 100;
const MAX_PATTERN_LENGTH = 200;
/**
 * A caller-supplied pattern is caller-supplied backtracking. Cloudflare kills a
 * request that burns its CPU budget, so the blast radius is the one submission
 * that triggered it -- but there is no point handing a pathological regex a
 * long subject, so the tested value is bounded too.
 */
const MAX_PATTERN_SUBJECT = 4096;

// Leading underscores are reserved for conForm's own fields, so a schema can
// never declare one and `strict` can always exempt them.
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off', '']);

function fail(message: string): never {
  throw new ApiError('invalid_schema', message);
}

function readNumber(spec: Record<string, unknown>, key: string, name: string): number | undefined {
  const value = spec[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`Field "${name}": ${key} must be a number`);
  }
  return value;
}

/** Validates a declaration. Runs at configuration time, never on the delivery path. */
export function parseFormSchema(value: unknown): FormSchema {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('schema must be an object');
  }
  const raw = value as Record<string, unknown>;

  if (raw.strict !== undefined && typeof raw.strict !== 'boolean') {
    fail('schema.strict must be a boolean');
  }
  if (!raw.fields || typeof raw.fields !== 'object' || Array.isArray(raw.fields)) {
    fail('schema.fields must be an object');
  }

  const rawFields = raw.fields as Record<string, unknown>;
  const names = Object.keys(rawFields);
  if (names.length === 0) fail('schema.fields must declare at least one field');
  if (names.length > MAX_SCHEMA_FIELDS) {
    fail(`schema.fields may declare at most ${MAX_SCHEMA_FIELDS} fields`);
  }

  const fields: Record<string, FieldSpec> = {};
  for (const name of names) {
    if (!FIELD_NAME.test(name)) {
      fail(
        `Field "${name}": names start with a letter and use letters, digits, "_", "." or "-" ` +
          '(leading underscores are reserved for conForm)',
      );
    }
    const entry = rawFields[name];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`Field "${name}": must be an object`);
    }
    const spec = entry as Record<string, unknown>;

    const type = spec.type === undefined ? 'text' : spec.type;
    if (typeof type !== 'string' || !(FIELD_TYPES as readonly string[]).includes(type)) {
      fail(`Field "${name}": type must be one of ${FIELD_TYPES.join(', ')}`);
    }
    for (const flag of ['required', 'multiple'] as const) {
      if (spec[flag] !== undefined && typeof spec[flag] !== 'boolean') {
        fail(`Field "${name}": ${flag} must be a boolean`);
      }
    }

    const min = readNumber(spec, 'min', name);
    const max = readNumber(spec, 'max', name);
    const minLength = readNumber(spec, 'min_length', name);
    const maxLength = readNumber(spec, 'max_length', name);
    if (min !== undefined && max !== undefined && min > max) {
      fail(`Field "${name}": min is greater than max`);
    }
    if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
      fail(`Field "${name}": min_length is greater than max_length`);
    }

    let pattern: string | undefined;
    if (spec.pattern !== undefined) {
      if (typeof spec.pattern !== 'string') fail(`Field "${name}": pattern must be a string`);
      if (spec.pattern.length > MAX_PATTERN_LENGTH) {
        fail(`Field "${name}": pattern may be at most ${MAX_PATTERN_LENGTH} characters`);
      }
      try {
        new RegExp(spec.pattern, 'u');
      } catch {
        fail(`Field "${name}": pattern is not a valid regular expression`);
      }
      pattern = spec.pattern;
    }

    let options: string[] | undefined;
    if (spec.options !== undefined) {
      if (!Array.isArray(spec.options) || spec.options.some((o) => typeof o !== 'string')) {
        fail(`Field "${name}": options must be an array of strings`);
      }
      if (spec.options.length === 0) fail(`Field "${name}": options must not be empty`);
      if (spec.options.length > MAX_OPTIONS) {
        fail(`Field "${name}": at most ${MAX_OPTIONS} options`);
      }
      options = spec.options as string[];
    }
    if (type === 'choice' && !options) {
      fail(`Field "${name}": a choice field needs options`);
    }

    fields[name] = {
      type: type as FieldType,
      ...(spec.required === true ? { required: true } : {}),
      ...(spec.multiple === true ? { multiple: true } : {}),
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
      ...(minLength === undefined ? {} : { min_length: minLength }),
      ...(maxLength === undefined ? {} : { max_length: maxLength }),
      ...(pattern === undefined ? {} : { pattern }),
      ...(options === undefined ? {} : { options }),
    };
  }

  return { strict: raw.strict !== false, fields };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const TIME = /^\d{2}:\d{2}(:\d{2})?$/u;

function isRealDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isRealTime(value: string): boolean {
  if (!TIME.test(value)) return false;
  const [hours, minutes, seconds] = value.split(':').map(Number);
  return hours < 24 && minutes < 60 && (seconds === undefined || seconds < 60);
}

function checkType(value: string, spec: FieldSpec): FieldError['code'] | undefined {
  switch (spec.type) {
    case 'email':
      // Same shape the reply-to path accepts, so a form cannot declare an
      // address the delivery layer would then refuse to use.
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) && value.length <= 254
        ? undefined
        : 'invalid_email';
    case 'tel':
      // Deliberately loose: numbering plans vary and a strict pattern turns
      // away real people. A form that needs a shape declares one.
      return /^[+()\d][\d\s().-]{4,31}$/u.test(value) ? undefined : 'invalid_tel';
    case 'url':
      try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:'
          ? undefined
          : 'invalid_url';
      } catch {
        return 'invalid_url';
      }
    case 'integer':
      return /^[+-]?\d+$/u.test(value) ? undefined : 'invalid_integer';
    case 'number':
      return value.trim() !== '' && Number.isFinite(Number(value))
        ? undefined
        : 'invalid_number';
    case 'date':
      return isRealDate(value) ? undefined : 'invalid_date';
    case 'time':
      return isRealTime(value) ? undefined : 'invalid_time';
    case 'datetime':
      return Number.isFinite(Date.parse(value)) ? undefined : 'invalid_datetime';
    case 'boolean':
      // An unchecked checkbox sends nothing and a checked one sends "on", so
      // both spellings have to be accepted or every checkbox form fails.
      return TRUE_VALUES.has(value.toLowerCase()) || FALSE_VALUES.has(value.toLowerCase())
        ? undefined
        : 'invalid_boolean';
    default:
      return undefined;
  }
}

function checkValue(name: string, value: string, spec: FieldSpec): FieldError[] {
  const errors: FieldError[] = [];
  const push = (code: string, message: string) => errors.push({ field: name, code, message });

  const typeError = checkType(value, spec);
  if (typeError) {
    push(typeError, `"${name}" is not a valid ${spec.type}`);
    // Range and length checks against a value of the wrong type would only
    // restate the same problem in a second, more confusing error.
    return errors;
  }

  if (spec.options && !spec.options.includes(value)) {
    push('not_an_option', `"${name}" must be one of the allowed options`);
  }
  if (spec.min_length !== undefined && value.length < spec.min_length) {
    push('too_short', `"${name}" must be at least ${spec.min_length} characters`);
  }
  if (spec.max_length !== undefined && value.length > spec.max_length) {
    push('too_long', `"${name}" must be at most ${spec.max_length} characters`);
  }
  if (spec.min !== undefined || spec.max !== undefined) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      if (spec.min !== undefined && numeric < spec.min) {
        push('below_minimum', `"${name}" must be at least ${spec.min}`);
      }
      if (spec.max !== undefined && numeric > spec.max) {
        push('above_maximum', `"${name}" must be at most ${spec.max}`);
      }
    }
  }
  if (spec.pattern !== undefined && value.length <= MAX_PATTERN_SUBJECT) {
    if (!new RegExp(spec.pattern, 'u').test(value)) {
      push('pattern_mismatch', `"${name}" is not in the expected format`);
    }
  }
  return errors;
}

function values(value: SubmissionValue): string[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * Checks a submission against a declaration.
 *
 * Empty counts as absent for `required`, which is the whole point: a browser
 * omits a disabled input entirely, so a required field arriving as an empty
 * string is a sender that assembled the body from the page source rather than
 * from a form. Treating "" as present would let exactly that through.
 */
export function validateSubmission(
  schema: FormSchema,
  fields: SubmissionFields,
): FieldError[] {
  const errors: FieldError[] = [];

  for (const [name, spec] of Object.entries(schema.fields)) {
    const raw = fields[name];
    const present = raw !== undefined && values(raw).some((entry) => entry.trim() !== '');

    if (!present) {
      if (spec.required) {
        errors.push({
          field: name,
          code: 'required',
          message: `"${name}" is required`,
        });
      }
      continue;
    }

    const entries = values(raw);
    if (entries.length > 1 && !spec.multiple) {
      errors.push({
        field: name,
        code: 'too_many_values',
        message: `"${name}" accepts a single value`,
      });
      continue;
    }
    for (const entry of entries) {
      if (entry.trim() === '') continue;
      errors.push(...checkValue(name, entry, spec));
    }
  }

  if (schema.strict) {
    for (const name of Object.keys(fields)) {
      if (schema.fields[name] === undefined) {
        errors.push({
          field: name,
          code: 'unknown_field',
          message: `"${name}" is not a field on this form`,
        });
      }
    }
  }

  return errors;
}
