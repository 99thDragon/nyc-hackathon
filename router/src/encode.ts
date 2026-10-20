// Binary container for TimetableData. Browser-safe: Uint8Array, DataView, TextEncoder/TextDecoder only.
// Layout: "MCTT", uint32 version, uint32 header length, UTF-8 JSON header, then typed array sections, each 8-byte
// aligned, little-endian. Section offsets in the header are relative to the first section.
import type { TimetableData } from "./timetable.ts";

const MAGIC = 0x5454434d; // "MCTT" read little-endian
const VERSION = 1;

type ArrayType = "f64" | "f32" | "i32" | "u8" | "i8";
type Typed = Float64Array | Float32Array | Int32Array | Uint8Array | Int8Array;

const SCALARS = ["serviceDate", "referenceEpoch", "timeZone"] as const;
const STRINGS = [
  "stopID", "stopName", "routeID", "routeShortName", "routeLongName", "routeColor", "routeTextColor",
  "tripID", "tripShortName", "tripHeadsign",
] as const;
const ARRAYS: Record<string, ArrayType> = {
  stopLat: "f64", stopLon: "f64", stopParent: "i32", stopLocationType: "u8", stopDirection: "u8", stopMode: "u8",
  stopPatternOffsets: "i32", stopPatternRefs: "i32", stopPatternPositions: "i32", routeType: "i32",
  patternRoute: "i32", patternShape: "i32", patternStopOffsets: "i32", patternTripOffsets: "i32",
  patternEventOffsets: "i32", patternStops: "i32", patternStopFlags: "u8", patternStopShapePoint: "i32",
  tripDayOffset: "i8", arrivals: "i32", departures: "i32", shapeOffsets: "i32", shapeLat: "f32", shapeLon: "f32",
  transferFrom: "i32", transferTo: "i32", transferType: "u8", transferSeconds: "i32",
};
const CONSTRUCTORS = {
  f64: Float64Array,
  f32: Float32Array,
  i32: Int32Array,
  u8: Uint8Array,
  i8: Int8Array,
} as const;

interface Header {
  scalars: Record<string, string | number>;
  strings: Record<string, string[]>;
  sections: { name: string; type: ArrayType; offset: number; length: number }[];
}

const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const align = (n: number) => (n + 7) & ~7;

export function encode(data: TimetableData): Uint8Array {
  if (!littleEndian) throw new Error("big-endian hosts are not supported");
  const record = data as unknown as Record<string, unknown>;
  const header: Header = { scalars: {}, strings: {}, sections: [] };
  for (const name of SCALARS) header.scalars[name] = data[name];
  for (const name of STRINGS) header.strings[name] = data[name];
  let offset = 0;
  for (const [name, type] of Object.entries(ARRAYS)) {
    const array = record[name] as Typed;
    header.sections.push({ name, type, offset, length: array.length });
    offset = align(offset + array.byteLength);
  }
  const json = new TextEncoder().encode(JSON.stringify(header));
  const start = align(12 + json.length);
  const bytes = new Uint8Array(start + offset);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, json.length, true);
  bytes.set(json, 12);
  for (const section of header.sections) {
    const array = record[section.name] as Typed;
    bytes.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), start + section.offset);
  }
  return bytes;
}

// Typed arrays are views into `bytes` when it is 8-byte aligned, else into an aligned copy.
export function decode(input: Uint8Array): TimetableData {
  if (!littleEndian) throw new Error("big-endian hosts are not supported");
  const bytes = input.byteOffset % 8 === 0 ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || view.getUint32(0, true) !== MAGIC) throw new Error("not a timetable file");
  if (view.getUint32(4, true) !== VERSION) throw new Error("unsupported timetable version");
  const length = view.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + length))) as Header;
  const start = align(12 + length);
  const result: Record<string, unknown> = { ...header.scalars, ...header.strings };
  for (const section of header.sections) {
    const Type = CONSTRUCTORS[section.type];
    const byteOffset = bytes.byteOffset + start + section.offset;
    if (byteOffset + section.length * Type.BYTES_PER_ELEMENT > bytes.byteOffset + bytes.byteLength) {
      throw new Error(`truncated section ${section.name}`);
    }
    result[section.name] = new Type(bytes.buffer, byteOffset, section.length);
  }
  for (const name of [...SCALARS, ...STRINGS, ...Object.keys(ARRAYS)]) {
    if (!(name in result)) throw new Error(`missing ${name}`);
  }
  return result as unknown as TimetableData;
}
