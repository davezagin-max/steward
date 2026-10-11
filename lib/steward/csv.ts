/**
 * CSV writer for the glossary export (RFC 4180 quoting).
 *
 * Definitions are free text a reviewer can edit, and the file will be opened in a
 * spreadsheet. A cell that starts with `=`, `+`, `-`, `@`, tab, or carriage return would
 * be run as a formula, so those cells get a leading apostrophe.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
