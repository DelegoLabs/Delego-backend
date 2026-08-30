// Issue #116 — Dependency-free ICU Message Format engine backed by `Intl`.
//
// Supports the subset of ICU MessageFormat that matters for notification
// templates: arguments, `plural`/`selectordinal`, `select`, `number`,
// `currency`, `percent`, `date`, `time`, apostrophe escaping, and the `#`
// number placeholder inside plural options. Plural categories are selected at
// runtime with `Intl.PluralRules` so every supported locale gets correct
// pluralization (including ar/he with zero/two/few/many).

export class IcuSyntaxError extends Error {
  constructor(message: string) {
    super(`ICU syntax error: ${message}`);
    this.name = "IcuSyntaxError";
  }
}

type IcuNode =
  | { kind: "literal"; value: string }
  | { kind: "argument"; name: string }
  | { kind: "plural"; name: string; ordinal: boolean; options: IcuSelectionOption[] }
  | { kind: "select"; name: string; options: IcuSelectionOption[] }
  | { kind: "number"; name: string; style?: string }
  | { kind: "currency"; name: string; code?: string }
  | { kind: "percent"; name: string }
  | { kind: "date"; name: string; style?: string }
  | { kind: "time"; name: string; style?: string };

interface IcuSelectionOption {
  match: string;
  nodes: IcuNode[];
}

interface Parser {
  text: string;
  pos: number;
  len: number;
}

function skipWhitespace(p: Parser): void {
  while (p.pos < p.len && /\s/.test(p.text[p.pos])) p.pos++;
}

function readUntil(p: Parser, stopChars: string): string {
  const start = p.pos;
  while (p.pos < p.len && !stopChars.includes(p.text[p.pos])) p.pos++;
  return p.text.slice(start, p.pos);
}

/** Parse the message into a node tree. Throws {@link IcuSyntaxError} on bad input. */
export function parseIcuMessage(message: string): IcuNode[] {
  if (typeof message !== "string") {
    throw new IcuSyntaxError(`message must be a string, got ${typeof message}`);
  }
  const p: Parser = { text: message, pos: 0, len: message.length };
  const nodes = parseMessageNodes(p, false);
  if (p.pos < p.len) {
    throw new IcuSyntaxError(`unexpected trailing input at position ${p.pos}`);
  }
  return nodes;
}

function parseMessageNodes(p: Parser, stopAtBrace: boolean): IcuNode[] {
  const nodes: IcuNode[] = [];
  let literal = "";
  const flush = (): void => {
    if (literal.length > 0) {
      nodes.push({ kind: "literal", value: literal });
      literal = "";
    }
  };

  while (p.pos < p.len) {
    const ch = p.text[p.pos];
    if (ch === "'") {
      const next = p.text[p.pos + 1];
      if (next === "'") {
        literal += "'";
        p.pos += 2;
      } else {
        // Quoted section — scan for the closing apostrophe. A doubled
        // apostrophe inside the quote represents a literal `'`.
        let j = p.pos + 1;
        let quoted = "";
        let closed = false;
        while (j < p.len) {
          if (p.text[j] === "'") {
            if (p.text[j + 1] === "'") {
              quoted += "'";
              j += 2;
            } else {
              closed = true;
              j++;
              break;
            }
          } else {
            quoted += p.text[j];
            j++;
          }
        }
        if (closed) {
          literal += quoted;
          p.pos = j;
        } else {
          // Unmatched apostrophe is a literal apostrophe; text continues.
          literal += "'";
          p.pos++;
        }
      }
    } else if (ch === "{") {
      flush();
      nodes.push(parsePlaceholder(p));
    } else if (ch === "}") {
      if (stopAtBrace) break;
      throw new IcuSyntaxError(`unexpected "}" at position ${p.pos}`);
    } else {
      literal += ch;
      p.pos++;
    }
  }
  flush();
  return nodes;
}

function parsePlaceholder(p: Parser): IcuNode {
  p.pos++; // consume '{'
  skipWhitespace(p);
  const name = readUntil(p, ",}");
  if (name.length === 0) {
    throw new IcuSyntaxError(`empty argument name at position ${p.pos}`);
  }
  if (p.pos >= p.len) {
    throw new IcuSyntaxError(`unterminated placeholder "${name}"`);
  }

  // Simple argument: {name}
  if (p.text[p.pos] === "}") {
    p.pos++;
    return { kind: "argument", name };
  }

  p.pos++; // consume ','
  skipWhitespace(p);
  const type = readUntil(p, ",}").trim().toLowerCase();
  if (type.length === 0) {
    throw new IcuSyntaxError(`missing format type for argument "${name}"`);
  }

  switch (type) {
    case "plural":
    case "selectordinal": {
      p.pos++; // consume ',' (or '}' if it somehow follows directly)
      const options = parseSelectionOptions(p, name, "plural");
      expectClosingBrace(p, name);
      return { kind: "plural", name, ordinal: type === "selectordinal", options };
    }
    case "select": {
      p.pos++;
      const options = parseSelectionOptions(p, name, "select");
      expectClosingBrace(p, name);
      return { kind: "select", name, options };
    }
    case "number": {
      let style: string | undefined;
      if (p.pos < p.len && p.text[p.pos] === ",") {
        p.pos++;
        style = readUntil(p, "}").trim();
      }
      expectClosingBrace(p, name);
      return { kind: "number", name, style };
    }
    case "currency": {
      let code: string | undefined;
      if (p.pos < p.len && p.text[p.pos] === ",") {
        p.pos++;
        code = readUntil(p, "}").trim().toUpperCase();
      }
      expectClosingBrace(p, name);
      return { kind: "currency", name, code };
    }
    case "percent": {
      expectClosingBrace(p, name);
      return { kind: "percent", name };
    }
    case "date":
    case "time": {
      let style: string | undefined;
      if (p.pos < p.len && p.text[p.pos] === ",") {
        p.pos++;
        style = readUntil(p, "}").trim();
      }
      expectClosingBrace(p, name);
      return { kind: type, name, style };
    }
    default:
      throw new IcuSyntaxError(
        `unsupported format type "${type}" for argument "${name}"`
      );
  }
}

function parseSelectionOptions(
  p: Parser,
  name: string,
  kind: "plural" | "select"
): IcuSelectionOption[] {
  const options: IcuSelectionOption[] = [];
  // We are positioned right after the type's ',' — the option list starts
  // with either a keyword or an '='-prefixed exact match.
  for (;;) {
    skipWhitespace(p);
    if (p.pos >= p.len) {
      throw new IcuSyntaxError(`unterminated ${kind} for argument "${name}"`);
    }
    if (p.text[p.pos] === "}") break;
    if (p.text[p.pos] === ",") {
      p.pos++;
      continue;
    }

    const match = readUntil(p, "{");
    if (match.length === 0) {
      throw new IcuSyntaxError(`missing ${kind} keyword for argument "${name}"`);
    }
    const trimmed = match.trim();
    if (kind === "plural" && !/^(other|=(-?\d+)|zero|one|two|few|many)$/.test(trimmed)) {
      throw new IcuSyntaxError(
        `invalid ${kind} keyword "${trimmed}" for argument "${name}"`
      );
    }
    if (kind === "select" && trimmed === "=") {
      throw new IcuSyntaxError(`invalid select keyword for argument "${name}"`);
    }

    skipWhitespace(p);
    if (p.pos >= p.len || p.text[p.pos] !== "{") {
      throw new IcuSyntaxError(`expected "{" after "${trimmed}" keyword for "${name}"`);
    }
    p.pos++; // consume '{'
    const nodes = parseMessageNodes(p, true);
    if (p.pos >= p.len || p.text[p.pos] !== "}") {
      throw new IcuSyntaxError(`unterminated option block "${trimmed}" for "${name}"`);
    }
    p.pos++; // consume '}'
    options.push({ match: trimmed, nodes });
  }
  return options;
}

function expectClosingBrace(p: Parser, name: string): void {
  if (p.pos >= p.len || p.text[p.pos] !== "}") {
    throw new IcuSyntaxError(`expected "}" for argument "${name}"`);
  }
  p.pos++;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Format an ICU message. Missing arguments are reported via `missing`. */
export function formatIcuMessage(
  message: string,
  args: Record<string, unknown>,
  locale: string
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const nodes = parseIcuMessage(message);
  const text = formatNodes(nodes, args, locale, missing);
  return { text, missing };
}

/** Convenience wrapper that just returns the string. */
export function formatIcu(message: string, args: Record<string, unknown>, locale: string): string {
  return formatIcuMessage(message, args, locale).text;
}

function formatNodes(
  nodes: IcuNode[],
  args: Record<string, unknown>,
  locale: string,
  missing: string[]
): string {
  let out = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "literal":
        out += node.value;
        break;
      case "argument":
        out += stringifyArgument(node.name, args, missing);
        break;
      case "number":
        out += formatNumber(node.name, args, locale, node.style, missing);
        break;
      case "currency":
        out += formatCurrency(node.name, args, locale, node.code, missing);
        break;
      case "percent":
        out += formatPercent(node.name, args, locale, missing);
        break;
      case "date":
        out += formatDate(node.name, args, locale, node.style, false, missing);
        break;
      case "time":
        out += formatDate(node.name, args, locale, node.style, true, missing);
        break;
      case "plural":
        out += formatPlural(node, args, locale, missing);
        break;
      case "select":
        out += formatSelect(node, args, locale, missing);
        break;
    }
  }
  return out;
}

function stringifyArgument(name: string, args: Record<string, unknown>, missing: string[]): string {
  const value = args[name];
  if (value === undefined || value === null) {
    missing.push(name);
    return `{${name}}`;
  }
  return String(value);
}

function toFiniteNumber(name: string, args: Record<string, unknown>, missing: string[]): number | null {
  const value = args[name];
  if (value === undefined || value === null) {
    missing.push(name);
    return null;
  }
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(n)) {
    missing.push(name);
    return null;
  }
  return n;
}

function formatNumber(
  name: string,
  args: Record<string, unknown>,
  locale: string,
  style: string | undefined,
  missing: string[]
): string {
  const n = toFiniteNumber(name, args, missing);
  if (n === null) return `{${name}}`;
  const options: Intl.NumberFormatOptions = {};
  switch (style) {
    case "integer":
      options.maximumFractionDigits = 0;
      break;
    case "percent":
      return new Intl.NumberFormat(locale, { style: "percent" }).format(n);
    default:
      break;
  }
  return new Intl.NumberFormat(locale, options).format(n);
}

function formatCurrency(
  name: string,
  args: Record<string, unknown>,
  locale: string,
  code: string | undefined,
  missing: string[]
): string {
  const n = toFiniteNumber(name, args, missing);
  if (n === null) return `{${name}}`;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: code ?? "USD",
  }).format(n);
}

function formatPercent(
  name: string,
  args: Record<string, unknown>,
  locale: string,
  missing: string[]
): string {
  const n = toFiniteNumber(name, args, missing);
  if (n === null) return `{${name}}`;
  return new Intl.NumberFormat(locale, { style: "percent" }).format(n);
}

function formatDate(
  name: string,
  args: Record<string, unknown>,
  locale: string,
  style: string | undefined,
  time: boolean,
  missing: string[]
): string {
  const value = args[name];
  if (value === undefined || value === null) {
    missing.push(name);
    return `{${name}}`;
  }
  const date = value instanceof Date ? value : new Date(value as string | number);
  if (Number.isNaN(date.getTime())) {
    missing.push(name);
    return `{${name}}`;
  }
  const validStyles: Array<Intl.DateTimeFormatOptions["dateStyle"]> = [
    "short",
    "medium",
    "long",
    "full",
  ];
  const resolved = validStyles.includes(style as Intl.DateTimeFormatOptions["dateStyle"])
    ? (style as Intl.DateTimeFormatOptions["dateStyle"])
    : "medium";
  if (time) {
    return new Intl.DateTimeFormat(locale, { timeStyle: resolved }).format(date);
  }
  return new Intl.DateTimeFormat(locale, { dateStyle: resolved }).format(date);
}

function formatPlural(
  node: Extract<IcuNode, { kind: "plural" }>,
  args: Record<string, unknown>,
  locale: string,
  missing: string[]
): string {
  const n = toFiniteNumber(node.name, args, missing);
  if (n === null) return `{${node.name}}`;

  // Exact-match options win: =0, =1, ...
  for (const option of node.options) {
    if (option.match.startsWith("=") && Number(option.match.slice(1)) === n) {
      return formatPluralOption(option, args, locale, n, missing);
    }
  }

  const pluralRules = new Intl.PluralRules(locale, {
    type: node.ordinal ? "ordinal" : "cardinal",
  });
  const category = pluralRules.select(n);
  for (const option of node.options) {
    if (option.match === category) {
      return formatPluralOption(option, args, locale, n, missing);
    }
  }

  const other = node.options.find((o) => o.match === "other");
  if (other) {
    return formatPluralOption(other, args, locale, n, missing);
  }
  return "";
}

function formatPluralOption(
  option: IcuSelectionOption,
  args: Record<string, unknown>,
  locale: string,
  numberValue: number,
  missing: string[]
): string {
  const rendered = formatNodes(option.nodes, args, locale, missing);
  if (rendered.includes("#")) {
    const formatted = new Intl.NumberFormat(locale).format(numberValue);
    return rendered.replace(/#/g, formatted);
  }
  return rendered;
}

function formatSelect(
  node: Extract<IcuNode, { kind: "select" }>,
  args: Record<string, unknown>,
  locale: string,
  missing: string[]
): string {
  const value = args[node.name];
  const key = value === undefined || value === null ? "" : String(value);
  if (value === undefined || value === null) {
    missing.push(node.name);
  }
  for (const option of node.options) {
    if (option.match === key) {
      return formatNodes(option.nodes, args, locale, missing);
    }
  }
  const other = node.options.find((o) => o.match === "other");
  if (other) {
    return formatNodes(other.nodes, args, locale, missing);
  }
  return "";
}

// ---------------------------------------------------------------------------
// Introspection helpers (used by validation)
// ---------------------------------------------------------------------------

/** Collect the names of every argument referenced by the message. */
export function extractIcuArguments(message: string): string[] {
  const nodes = parseIcuMessage(message);
  const seen = new Set<string>();
  const walk = (list: IcuNode[]): void => {
    for (const node of list) {
      switch (node.kind) {
        case "literal":
          break;
        case "argument":
          seen.add(node.name);
          break;
        case "number":
        case "currency":
        case "percent":
        case "date":
        case "time":
          seen.add(node.name);
          break;
        case "plural":
        case "select":
          seen.add(node.name);
          for (const option of node.options) walk(option.nodes);
          break;
      }
    }
  };
  walk(nodes);
  return [...seen];
}

/**
 * Convert legacy `{{key}}` placeholders (used by the pre-ICU translation
 * files) into ICU `{key}` arguments so old templates render through the same
 * engine.
 */
export function normalizeLegacyPlaceholders(message: string): string {
  return message.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => `{${key}}`);
}
