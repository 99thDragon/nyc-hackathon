// Streaming RFC 4180 reader for GTFS files. Node-only. Skips a leading BOM and blank lines, accepts LF and CRLF,
// trims spaces and tabs around every field, and tolerates text after a closing quote.
import fs from "node:fs";

export type Header = (name: string) => number;

function trim(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && (text.charCodeAt(start) === 32 || text.charCodeAt(start) === 9)) start++;
  while (end > start && (text.charCodeAt(end - 1) === 32 || text.charCodeAt(end - 1) === 9)) end--;
  return start === 0 && end === text.length ? text : text.slice(start, end);
}

// Fields of one record, or null when a quoted field continues past the end of `line`.
function parseQuoted(line: string): string[] | null {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && trim(field) === "") {
      field = "";
      quoted = true;
    } else if (c === ",") {
      fields.push(trim(field));
      field = "";
    } else field += c;
  }
  if (quoted) return null;
  fields.push(trim(field));
  return fields;
}

export async function forEachRecord(path: string, body: (fields: string[]) => void): Promise<void> {
  let pending = "";
  let carry = "";
  let first = true;
  const emit = (line: string) => {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    const text = carry ? carry + "\n" + line : line;
    if (text.indexOf('"') < 0) {
      carry = "";
      if (text.trim() === "") return;
      const fields = text.split(",");
      for (let i = 0; i < fields.length; i++) fields[i] = trim(fields[i]);
      body(fields);
      return;
    }
    const fields = parseQuoted(text);
    if (!fields) {
      carry = text;
      return;
    }
    carry = "";
    body(fields);
  };
  for await (const chunk of fs.createReadStream(path, { encoding: "utf8", highWaterMark: 1 << 20 })) {
    let text = pending + (chunk as string);
    if (first) {
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      first = false;
    }
    let start = 0;
    for (let end = text.indexOf("\n"); end >= 0; end = text.indexOf("\n", start)) {
      emit(text.slice(start, end));
      start = end + 1;
    }
    pending = text.slice(start);
  }
  if (pending) emit(pending);
  if (carry) throw new Error(`${path}: unterminated quote`);
}

// Calls `body` for every record after the header. `header(name)` is the column index, or -1.
export async function forEachRow(path: string, body: (header: Header, fields: string[]) => void): Promise<void> {
  let header: Header | null = null;
  await forEachRecord(path, (fields) => {
    if (header) return body(header, fields);
    const columns = new Map<string, number>();
    fields.forEach((name, index) => {
      if (!columns.has(name)) columns.set(name, index);
    });
    header = (name) => columns.get(name) ?? -1;
  });
}

export function field(fields: string[], index: number): string {
  return index >= 0 && index < fields.length ? fields[index] : "";
}

export function int(fields: string[], index: number): number | null {
  const text = field(fields, index);
  return /^-?\d+$/.test(text) ? Number(text) : null;
}

export function double(fields: string[], index: number): number | null {
  const text = field(fields, index);
  if (text === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

// GTFS H:MM:SS or HH:MM:SS as seconds; hours may exceed 23.
export function gtfsTime(fields: string[], index: number): number | null {
  const match = /^(\d+):(\d+):(\d+)$/.exec(field(fields, index));
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}
