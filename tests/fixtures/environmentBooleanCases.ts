/** Characterized configuration contracts; null means use the caller's fallback. */
export const environmentBooleanCases: Array<{
  label: string;
  value: string | undefined;
  legacy: boolean | null;
  extended: boolean | null;
}> = [
  { label: 'unset', value: undefined, legacy: null, extended: null },
  { label: 'empty', value: '', legacy: null, extended: null },
  { label: 'whitespace', value: ' \t ', legacy: null, extended: null },
  { label: 'true', value: 'true', legacy: true, extended: true },
  { label: 'false', value: 'false', legacy: false, extended: false },
  { label: 'one', value: '1', legacy: true, extended: true },
  { label: 'zero', value: '0', legacy: false, extended: false },
  { label: 'yes', value: 'yes', legacy: true, extended: true },
  { label: 'no', value: 'no', legacy: false, extended: false },
  { label: 'on', value: 'on', legacy: false, extended: true },
  { label: 'off', value: 'off', legacy: false, extended: false },
  { label: 'unknown', value: 'maybe', legacy: false, extended: null },
  { label: 'other number', value: '2', legacy: false, extended: null },
  { label: 'literal null', value: 'null', legacy: false, extended: null },
  { label: 'literal undefined', value: 'undefined', legacy: false, extended: null },
  { label: 'padded uppercase true', value: ' TRUE ', legacy: true, extended: true },
  { label: 'padded mixed-case false', value: ' False ', legacy: false, extended: false },
  { label: 'padded mixed-case yes', value: ' YeS ', legacy: true, extended: true },
  { label: 'padded mixed-case no', value: ' nO ', legacy: false, extended: false },
  { label: 'padded uppercase on', value: ' ON ', legacy: false, extended: true },
  { label: 'padded mixed-case off', value: ' oFF ', legacy: false, extended: false },
];
