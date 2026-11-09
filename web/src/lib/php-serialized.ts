/** The PHP serialized reader lives in shared, so the server reads dumps with the same code. */
export { controlRuns, fixSerializedLengths, looksSerialized, lostPropertyMarks, needsExactEditor, parseJsonValue, parsePhpSerialized, propertyName, withNulMarks } from '@devmagic-panel/shared';
export type { PhpValue, PropertyName, TextRun } from '@devmagic-panel/shared';
