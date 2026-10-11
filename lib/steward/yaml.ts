/**
 * A small YAML emitter for the data contract.
 *
 * It only needs to write plain data (maps, lists, strings, numbers, booleans, null), so
 * it stays tiny and its output order is exactly the insertion order of the input, which
 * keeps the contract diff-friendly. Strings are written plain only when that is
 * unambiguous; everything else is double-quoted using JSON escaping, which YAML accepts.
 * `tests/steward/yaml.test.ts` round-trips the output through a real YAML parser.
 */
export type Yaml = null | boolean | number | string | Yaml[] | { [key: string]: Yaml | undefined };

const PLAIN = /^[A-Za-z_][A-Za-z0-9_ ./()-]*$/;
const RESERVED = /^(true|false|yes|no|on|off|null|y|n|~)$/i;

export function yamlScalar(value: null | boolean | number | string): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (PLAIN.test(value) && !RESERVED.test(value) && value.trim() === value) return value;
  return JSON.stringify(value);
}

function isScalar(value: Yaml | undefined): value is null | boolean | number | string {
  return value === null || typeof value !== "object";
}

/** Short lists of scalars read better inline: `[loan_id, servicer_id]`. */
function inlineList(items: Yaml[]): string | null {
  if (!items.every(isScalar)) return null;
  const text = `[${items.map((item) => yamlScalar(item)).join(", ")}]`;
  return text.length <= 88 ? text : null;
}

function emit(value: Yaml, indent: number, lines: string[]): void {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isScalar(item)) {
        lines.push(`${pad}- ${yamlScalar(item)}`);
      } else if (Array.isArray(item)) {
        const inline = inlineList(item);
        if (inline) lines.push(`${pad}- ${inline}`);
        else {
          lines.push(`${pad}-`);
          emit(item, indent + 1, lines);
        }
      } else {
        const nested: string[] = [];
        emit(item, indent + 1, nested);
        if (nested.length === 0) lines.push(`${pad}- {}`);
        else {
          // Put the first key on the dash line: "- name: loan_id".
          lines.push(`${pad}- ${nested[0].trimStart()}`, ...nested.slice(1));
        }
      }
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      const name = yamlScalar(key);
      if (isScalar(child)) {
        lines.push(`${pad}${name}: ${yamlScalar(child)}`);
      } else if (Array.isArray(child)) {
        const inline = child.length === 0 ? "[]" : inlineList(child);
        if (inline) lines.push(`${pad}${name}: ${inline}`);
        else {
          lines.push(`${pad}${name}:`);
          emit(child, indent + 1, lines);
        }
      } else if (Object.values(child).every((entry) => entry === undefined)) {
        lines.push(`${pad}${name}: {}`);
      } else {
        lines.push(`${pad}${name}:`);
        emit(child, indent + 1, lines);
      }
    }
  }
}

export function toYaml(value: Yaml, header: string[] = []): string {
  const lines = header.map((line) => (line ? `# ${line}` : "#"));
  if (isScalar(value)) lines.push(yamlScalar(value));
  else if (Array.isArray(value) && value.length === 0) lines.push("[]");
  else emit(value, 0, lines);
  return `${lines.join("\n")}\n`;
}
