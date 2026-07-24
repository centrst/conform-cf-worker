import { isValidEmail } from './crypto';
import { ApiError } from './errors';
import type { SubmissionFields, SubmissionValue } from './types';

const INTERNAL_FIELDS = new Set([
  'access_key',
  'botcheck',
  '_gotcha',
  'redirect',
  '_redirect',
  'subject',
  '_subject',
  'format',
  '_format',
]);

export interface ParsedSubmission {
  allFields: SubmissionFields;
  fields: SubmissionFields;
  subject?: string;
  replyTo?: string;
  format: 'text' | 'json';
  spam: boolean;
}

function addField(fields: SubmissionFields, key: string, value: string): void {
  const existing = fields[key];
  if (existing === undefined) {
    fields[key] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    fields[key] = [existing, value];
  }
}

function valueAsString(value: SubmissionValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function cleanHeader(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[\r\n]+/gu, ' ').trim().slice(0, maxLength);
  return cleaned || undefined;
}

async function parseBody(request: Request, maxBytes: number): Promise<SubmissionFields> {
  const declaredLength = Number.parseInt(request.headers.get('content-length') ?? '0', 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ApiError('submission_too_large', 'Form submission is too large');
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxBytes) {
    throw new ApiError('submission_too_large', 'Form submission is too large');
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new ApiError('invalid_json', 'Invalid JSON body');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ApiError('invalid_json', 'JSON form body must be an object');
    }

    const fields = Object.create(null) as SubmissionFields;
    for (const [key, rawValue] of Object.entries(parsed as Record<string, unknown>)) {
      if (rawValue === null || rawValue === undefined) continue;
      if (Array.isArray(rawValue)) {
        fields[key] = rawValue.map((value) =>
          typeof value === 'string' ? value : JSON.stringify(value),
        );
      } else {
        fields[key] =
          typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue);
      }
    }
    return fields;
  }

  if (
    contentType.includes('application/x-www-form-urlencoded') ||
    contentType.includes('multipart/form-data')
  ) {
    const copy = new Request(request.url, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: bytes,
    });
    const form = await copy.formData();
    const fields = Object.create(null) as SubmissionFields;
    form.forEach((value, key) => {
      if (typeof value !== 'string') {
        throw new ApiError('file_uploads_unsupported', 'File uploads are not supported');
      }
      addField(fields, key, value);
    });
    return fields;
  }

  throw new ApiError(
    'unsupported_media_type',
    'Use application/json, application/x-www-form-urlencoded, or multipart/form-data',
  );
}

export async function parseSubmission(
  request: Request,
  maxBytes: number,
): Promise<ParsedSubmission> {
  const allFields = await parseBody(request, maxBytes);
  const fields = Object.create(null) as SubmissionFields;
  for (const [key, value] of Object.entries(allFields)) {
    if (!INTERNAL_FIELDS.has(key)) fields[key] = value;
  }

  const spamValue =
    valueAsString(allFields.botcheck) ?? valueAsString(allFields._gotcha);
  const rawReplyTo = valueAsString(fields.email);
  const rawFormat =
    valueAsString(allFields._format) ?? valueAsString(allFields.format);

  return {
    allFields,
    fields,
    subject: cleanHeader(
      valueAsString(allFields._subject) ?? valueAsString(allFields.subject),
      160,
    ),
    replyTo:
      rawReplyTo && isValidEmail(rawReplyTo.trim()) ? rawReplyTo.trim() : undefined,
    format: rawFormat?.toLowerCase() === 'json' ? 'json' : 'text',
    spam: Boolean(spamValue?.trim()),
  };
}

function displayValue(value: SubmissionValue): string {
  return Array.isArray(value) ? value.join('\n') : value;
}

export function submissionText(formName: string, fields: SubmissionFields): string {
  const lines = [`New submission from ${formName}`, ''];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}`, displayValue(value), '');
  }
  return lines.join('\n').trimEnd();
}

function base64EncodeUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function jsonAttachment(fields: SubmissionFields) {
  return {
    content: base64EncodeUtf8(JSON.stringify(fields, null, 2)),
    filename: 'submission.json',
    type: 'application/json',
    disposition: 'attachment' as const,
  };
}
