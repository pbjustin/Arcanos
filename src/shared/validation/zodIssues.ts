import { z } from 'zod';

export interface CompatibleZodIssue {
  code: string;
  path: PropertyKey[];
  message: string;
  [key: string]: unknown;
}

const englishError = z.locales.en().localeError;

function unwrapSchema(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (let depth = 0; depth < 32; depth += 1) {
    if (current instanceof z.ZodPipe) current = current.in as z.ZodType;
    else if (current instanceof z.ZodOptional || current instanceof z.ZodNullable
      || current instanceof z.ZodDefault || current instanceof z.ZodPrefault
      || current instanceof z.ZodCatch || current instanceof z.ZodReadonly) {
      current = current.unwrap() as z.ZodType;
    } else break;
  }
  return current;
}

function schemaAtPath(schema: z.ZodType | undefined, path: readonly PropertyKey[]): z.ZodType | undefined {
  let current = schema;
  for (const key of path) {
    if (!current) return undefined;
    current = unwrapSchema(current);
    if (current instanceof z.ZodObject) {
      const descriptor = Object.getOwnPropertyDescriptor(current.shape, key);
      current = descriptor && 'value' in descriptor ? descriptor.value as z.ZodType : undefined;
    } else if (current instanceof z.ZodArray && typeof key === 'number') {
      current = current.element as z.ZodType;
    } else if (current instanceof z.ZodRecord) {
      current = current.valueType as z.ZodType;
    } else return undefined;
  }
  return current ? unwrapSchema(current) : undefined;
}

function readOwnPath(input: unknown, path: readonly PropertyKey[]): unknown {
  let value = input;
  for (const key of path) {
    if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return undefined;
    value = descriptor.value;
  }
  return value;
}

function parsedType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isNaN(value)) return 'nan';
  if (value instanceof Date) return 'date';
  return typeof value;
}

function quotedValues(values: readonly unknown[]): string {
  return values.map(value => typeof value === 'string' ? `'${value}'` : String(value)).join(' | ');
}

function literalJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item);
}

function compatibleMessage(issue: z.core.$ZodIssue, value: unknown, fallback: string): string {
  // Keep explicit schema/refinement messages. Consult an isolated locale formatter,
  // rather than changing Zod's process-wide configuration or retaining raw input.
  const received = 'received' in issue ? issue.received : undefined;
  const localeInput = issue.code === 'invalid_type' && issue.expected === 'int' ? 0.5
    : received === 'NaN' ? NaN : value;
  const defaultMessage = englishError?.({ ...issue, input: localeInput } as z.core.$ZodRawIssue);
  return issue.message === defaultMessage ? fallback : issue.message;
}

function formatIssue(
  issue: z.core.$ZodIssue,
  input: unknown,
  prefix: PropertyKey[] = [],
  schema?: z.ZodType,
  schemaPrefix: PropertyKey[] = []
): CompatibleZodIssue {
  const path = [...prefix, ...issue.path];
  const value = readOwnPath(input, path);
  const leafSchema = schemaAtPath(schema, path.slice(schemaPrefix.length));
  const message = (fallback: string) => compatibleMessage(issue, value, fallback);

  switch (issue.code) {
    case 'invalid_type': {
      const integer = issue.expected === 'int';
      const expected = integer ? 'integer' : issue.expected === 'record' ? 'object' : issue.expected;
      const received = integer ? 'float' : 'received' in issue && issue.received === 'NaN' ? 'nan' : parsedType(value);
      const fallback = received === 'undefined' ? 'Required' : `Expected ${expected}, received ${received}`;
      return integer
        ? { code: 'invalid_type', expected, received, message: message(fallback), path }
        : { code: 'invalid_type', expected, received, path, message: message(fallback) };
    }
    case 'too_small':
    case 'too_big': {
      const small = issue.code === 'too_small';
      const bound = small ? issue.minimum : issue.maximum;
      const type = issue.origin === 'int' ? 'number' : issue.origin;
      const exact = issue.exact ?? false;
      const comparison = exact ? 'exactly' : small ? 'at least' : 'at most';
      let fallback: string;
      if (type === 'string' || type === 'array') {
        fallback = `${type === 'string' ? 'String' : 'Array'} must contain ${comparison} ${bound} ${type === 'string' ? 'character(s)' : 'element(s)'}`;
      } else {
        const relation = exact ? 'exactly equal to' : small
          ? issue.inclusive ? 'greater than or equal to' : 'greater than'
          : issue.inclusive ? 'less than or equal to' : 'less than';
        fallback = `${type === 'bigint' ? 'BigInt' : 'Number'} must be ${relation} ${bound}`;
      }
      return {
        code: issue.code,
        ...(small ? { minimum: bound } : { maximum: bound }),
        type,
        inclusive: issue.inclusive,
        exact,
        message: message(fallback),
        path
      };
    }
    case 'invalid_value': {
      // Public issues merge enums and literals. The optional schema supplies
      // that distinction without importing the removed Zod 3 runtime.
      if (issue.values.length === 1 && !(leafSchema instanceof z.ZodEnum)) {
        const expected = issue.values[0];
        return {
          received: value,
          code: 'invalid_literal',
          expected,
          path,
          message: message(`Invalid literal value, expected ${literalJson(expected)}`)
        };
      }
      const expected = quotedValues(issue.values);
      if (typeof value !== 'string' && issue.values.every(option => typeof option === 'string')) {
        const received = parsedType(value);
        return {
          expected,
          received,
          code: 'invalid_type',
          path,
          message: message(received === 'undefined' ? 'Required' : `Expected ${expected}, received ${received}`)
        };
      }
      return {
        received: value,
        code: 'invalid_enum_value',
        options: [...issue.values],
        path,
        message: message(`Invalid enum value. Expected ${expected}, received '${value}'`)
      };
    }
    case 'unrecognized_keys':
      return {
        code: issue.code,
        keys: [...issue.keys],
        path,
        message: message(`Unrecognized key(s) in object: ${issue.keys.map(key => `'${key}'`).join(', ')}`)
      };
    case 'invalid_format': {
      const validation = issue.format === 'guid' ? 'uuid' : issue.format;
      const fallback = validation === 'regex' ? 'Invalid' : `Invalid ${validation}`;
      return validation === 'datetime' || validation === 'date' || validation === 'time'
        ? { code: 'invalid_string', validation, message: message(fallback), path }
        : { validation, code: 'invalid_string', message: message(fallback), path };
    }
    case 'invalid_union':
      if ('options' in issue && issue.options?.length) {
        return {
          code: 'invalid_union_discriminator',
          options: [...issue.options],
          path,
          message: message(`Invalid discriminator value. Expected ${quotedValues(issue.options)}`)
        };
      }
      return {
        code: issue.code,
        unionErrors: issue.errors.map((issues, index) => ({
          issues: issues.map(nested => formatIssue(nested, input, path,
            leafSchema instanceof z.ZodUnion ? leafSchema.options[index] as z.ZodType : undefined, path)),
          name: 'ZodError'
        })),
        path,
        message: message('Invalid input')
      };
    case 'custom':
      return { code: issue.code, ...(issue.params ? { params: issue.params } : {}), message: issue.message, path };
    default:
      // Keep unfamiliar issues bounded to their public classification and text.
      return { code: issue.code, path, message: issue.message };
  }
}

/** Preserve the established public validation envelope while parsing with Zod 4. */
export function formatZodIssues(
  error: Pick<z.ZodError, 'issues'>,
  originalInput: unknown,
  schema?: z.ZodType
): CompatibleZodIssue[] {
  return error.issues.map(issue => formatIssue(issue, originalInput, [], schema));
}

/** Preserve endpoints that historically returned the serialized Zod issue list. */
export function formatZodErrorMessage(error: Pick<z.ZodError, 'issues'>, originalInput: unknown, schema?: z.ZodType): string {
  return JSON.stringify(formatZodIssues(error, originalInput, schema), null, 2);
}
