// The parts of a GTFS-realtime FeedMessage the router reads, decoded from the protobuf wire format
// (gtfs-realtime.proto) by hand. Unknown fields and extensions, such as NYCT's, are skipped. Browser-safe.

export interface TripDescriptor {
  tripID: string | null;
  routeID: string | null;
  startDate: string | null; // YYYYMMDD
  relationship: number; // schedule_relationship: 1 added, 3 canceled, 7 deleted
}

export interface StopTimeEvent {
  delay: number | null;
  time: number | null; // POSIX seconds
}

export interface StopTimeUpdate {
  stopID: string | null;
  arrival: StopTimeEvent | null;
  departure: StopTimeEvent | null;
  skipped: boolean;
}

export interface TripUpdate {
  entityID: string;
  trip: TripDescriptor;
  stopTimes: StopTimeUpdate[];
}

export interface EntitySelector {
  agencyID: string | null;
  routeID: string | null;
  stopID: string | null;
  tripID: string | null;
}

// POSIX seconds; a missing bound is open.
export interface Period {
  start: number | null;
  end: number | null;
}

export interface Alert {
  id: string;
  periods: Period[];
  entities: EntitySelector[];
  header: string;
  description: string | null;
}

export interface FeedMessage {
  timestamp: number | null;
  tripUpdates: TripUpdate[];
  alerts: Alert[];
}

export class MalformedFeedError extends Error {
  constructor() {
    super("malformed GTFS-realtime message");
    this.name = "MalformedFeedError";
  }
}

export function isCanceled(trip: TripDescriptor): boolean {
  return trip.relationship === 3 || trip.relationship === 7;
}

export function periodContains(period: Period, time: number): boolean {
  return (period.start ?? -Infinity) <= time && time < (period.end ?? Infinity);
}

const utf8 = new TextDecoder("utf-8");

// Varint keys of field number and wire type, then varint, fixed 64-bit, length-delimited, or fixed 32-bit values.
// Groups do not occur in GTFS-realtime.
class WireReader {
  readonly bytes: Uint8Array;
  index: number;
  readonly end: number;
  // Low 32 bits of the last varint, exact; `varint()` returns the value as a double.
  low = 0;

  constructor(bytes: Uint8Array, start = 0, end = bytes.length) {
    this.bytes = bytes;
    this.index = start;
    this.end = end;
  }

  // [field, wire] or null at the end.
  field(): [number, number] | null {
    if (this.index >= this.end) return null;
    const key = this.varint();
    return [Math.floor(key / 8), this.low & 7];
  }

  varint(): number {
    let value = 0;
    let low = 0;
    let shift = 0;
    while (this.index < this.end && shift < 64) {
      const byte = this.bytes[this.index++];
      value += (byte & 0x7f) * 2 ** shift;
      if (shift < 32) low |= (byte & 0x7f) << shift;
      if (byte < 0x80) {
        this.low = low | 0;
        return value;
      }
      shift += 7;
    }
    throw new MalformedFeedError();
  }

  // int64 as a double; negative values come back as two's complement.
  int64(): number {
    const value = this.varint();
    return value >= 2 ** 63 ? value - 2 ** 64 : value;
  }

  message(): WireReader {
    const length = this.varint();
    if (length > this.end - this.index) throw new MalformedFeedError();
    const start = this.index;
    this.index += length;
    return new WireReader(this.bytes, start, this.index);
  }

  string(): string {
    const value = this.message();
    return utf8.decode(this.bytes.subarray(value.index, value.end));
  }

  skip(wire: number): void {
    let size: number;
    switch (wire) {
      case 0:
        this.varint();
        return;
      case 1:
        size = 8;
        break;
      case 2:
        this.message();
        return;
      case 5:
        size = 4;
        break;
      default:
        throw new MalformedFeedError();
    }
    if (size > this.end - this.index) throw new MalformedFeedError();
    this.index += size;
  }
}

export function decodeFeedMessage(bytes: Uint8Array): FeedMessage {
  const message: FeedMessage = { timestamp: null, tripUpdates: [], alerts: [] };
  const reader = new WireReader(bytes);
  for (let f = reader.field(); f; f = reader.field()) {
    const [field, wire] = f;
    if (field === 1 && wire === 2) {
      const header = reader.message();
      for (let h = header.field(); h; h = header.field()) {
        if (h[0] === 3 && h[1] === 0) message.timestamp = header.varint();
        else header.skip(h[1]);
      }
    } else if (field === 2 && wire === 2) {
      entity(reader.message(), message);
    } else {
      reader.skip(wire);
    }
  }
  return message;
}

function entity(reader: WireReader, message: FeedMessage): void {
  let id = "";
  let deleted = false;
  let tripUpdate: WireReader | null = null;
  let alert: WireReader | null = null;
  for (let f = reader.field(); f; f = reader.field()) {
    const [field, wire] = f;
    if (field === 1 && wire === 2) id = reader.string();
    else if (field === 2 && wire === 0) deleted = reader.varint() !== 0;
    else if (field === 3 && wire === 2) tripUpdate = reader.message();
    else if (field === 5 && wire === 2) alert = reader.message();
    else reader.skip(wire);
  }
  if (deleted) return;
  if (tripUpdate) {
    let trip = emptyTrip();
    const stopTimes: StopTimeUpdate[] = [];
    for (let f = tripUpdate.field(); f; f = tripUpdate.field()) {
      const [field, wire] = f;
      if (field === 1 && wire === 2) trip = tripDescriptor(tripUpdate.message());
      else if (field === 2 && wire === 2) stopTimes.push(stopTime(tripUpdate.message()));
      else tripUpdate.skip(wire);
    }
    message.tripUpdates.push({ entityID: id, trip, stopTimes });
  }
  if (alert) {
    const decoded: Alert = { id, periods: [], entities: [], header: "", description: null };
    for (let f = alert.field(); f; f = alert.field()) {
      const [field, wire] = f;
      if (field === 1 && wire === 2) {
        const range = alert.message();
        const period: Period = { start: null, end: null };
        for (let r = range.field(); r; r = range.field()) {
          if (r[0] === 1 && r[1] === 0) period.start = range.varint();
          else if (r[0] === 2 && r[1] === 0) period.end = range.varint();
          else range.skip(r[1]);
        }
        decoded.periods.push(period);
      } else if (field === 5 && wire === 2) {
        decoded.entities.push(selector(alert.message()));
      } else if (field === 10 && wire === 2) {
        decoded.header = text(alert.message()) ?? "";
      } else if (field === 11 && wire === 2) {
        decoded.description = text(alert.message());
      } else {
        alert.skip(wire);
      }
    }
    message.alerts.push(decoded);
  }
}

function emptyTrip(): TripDescriptor {
  return { tripID: null, routeID: null, startDate: null, relationship: 0 };
}

function tripDescriptor(reader: WireReader): TripDescriptor {
  const trip = emptyTrip();
  for (let f = reader.field(); f; f = reader.field()) {
    const [field, wire] = f;
    if (field === 1 && wire === 2) trip.tripID = reader.string();
    else if (field === 3 && wire === 2) trip.startDate = reader.string();
    else if (field === 4 && wire === 0) {
      reader.varint();
      trip.relationship = reader.low;
    } else if (field === 5 && wire === 2) trip.routeID = reader.string();
    else reader.skip(wire);
  }
  return trip;
}

function stopTime(reader: WireReader): StopTimeUpdate {
  const update: StopTimeUpdate = { stopID: null, arrival: null, departure: null, skipped: false };
  for (let f = reader.field(); f; f = reader.field()) {
    const [field, wire] = f;
    if (field === 2 && wire === 2) update.arrival = event(reader.message());
    else if (field === 3 && wire === 2) update.departure = event(reader.message());
    else if (field === 4 && wire === 2) update.stopID = reader.string();
    else if (field === 5 && wire === 0) update.skipped = reader.varint() === 1;
    else reader.skip(wire);
  }
  return update;
}

function event(reader: WireReader): StopTimeEvent {
  const decoded: StopTimeEvent = { delay: null, time: null };
  for (let f = reader.field(); f; f = reader.field()) {
    const [field, wire] = f;
    if (field === 1 && wire === 0) {
      reader.varint();
      decoded.delay = reader.low;
    } else if (field === 2 && wire === 0) {
      decoded.time = reader.int64();
    } else {
      reader.skip(wire);
    }
  }
  return decoded;
}

function selector(reader: WireReader): EntitySelector {
  const decoded: EntitySelector = { agencyID: null, routeID: null, stopID: null, tripID: null };
  for (let f = reader.field(); f; f = reader.field()) {
    const [field, wire] = f;
    if (field === 1 && wire === 2) decoded.agencyID = reader.string();
    else if (field === 2 && wire === 2) decoded.routeID = reader.string();
    else if (field === 4 && wire === 2) decoded.tripID = tripDescriptor(reader.message()).tripID;
    else if (field === 5 && wire === 2) decoded.stopID = reader.string();
    else reader.skip(wire);
  }
  return decoded;
}

// The English or untagged translation, else the first one that is not HTML.
function text(reader: WireReader): string | null {
  const translations: { text: string; language: string }[] = [];
  for (let f = reader.field(); f; f = reader.field()) {
    const [field, wire] = f;
    if (field !== 1 || wire !== 2) {
      reader.skip(wire);
      continue;
    }
    const translation = reader.message();
    let value = "";
    let language = "";
    for (let t = translation.field(); t; t = translation.field()) {
      if (t[0] === 1 && t[1] === 2) value = translation.string();
      else if (t[0] === 2 && t[1] === 2) language = translation.string();
      else translation.skip(t[1]);
    }
    translations.push({ text: value, language });
  }
  const chosen =
    translations.find((t) => t.language === "" || t.language === "en") ??
    translations.find((t) => !t.language.endsWith("html"));
  return chosen?.text ?? null;
}
