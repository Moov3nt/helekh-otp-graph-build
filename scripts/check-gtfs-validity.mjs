// Temporal validity gate for a static GTFS feed. Dependency-free (Node >= 18). Reads an EXTRACTED feed directory.
//
//   node check-gtfs-validity.mjs --dir <gtfs dir> --timezone Europe/Rome [--today YYYY-MM-DD] [--min-future-days N]
//                                [--must-cover-until YYYY-MM-DD] [--out report.json]
//
// A day counts as a service day only if a service that is active that day (weekly pattern inside its validity interval, then
// calendar_dates additions and removals) has at least one trip. Being between two declared dates is not enough.
// Exit code 0: the feed passes. 2: it does not (the report says why). 1: the script could not run.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const fail = (message) => {
  console.error(`check-gtfs-validity: ${message}`);
  process.exit(1);
};
const directory = args.get('--dir') ?? fail('--dir is required');
const timezone = args.get('--timezone') ?? fail('--timezone is required');
const minimumFutureDays = Number(args.get('--min-future-days') ?? '1');
if (!Number.isInteger(minimumFutureDays) || minimumFutureDays < 0) fail('--min-future-days must be a whole number >= 0');
const day = /^\d{4}-\d{2}-\d{2}$/;
const mustCoverUntil = args.get('--must-cover-until') ?? '';
if (mustCoverUntil !== '' && !day.test(mustCoverUntil)) fail('--must-cover-until must be YYYY-MM-DD');

function todayIn(zone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return parts;
}
const today = args.get('--today') ?? todayIn(timezone);
if (!day.test(today)) fail('--today must be YYYY-MM-DD');

// ---- CSV (quoted fields, doubled quotes, BOM, CRLF); each file is read once
function rows(file) {
  const path = join(directory, file);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line)).filter((line) => line.length > 0);
  const cells = (line) => {
    const out = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cell += '"'; i += 1; } else if (c === '"') quoted = false; else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { out.push(cell); cell = ''; } else cell += c;
    }
    out.push(cell);
    return out;
  };
  if (lines.length === 0) return [];
  const header = cells(lines[0]);
  return lines.slice(1).map((line) => {
    const values = cells(line);
    return Object.fromEntries(header.map((name, i) => [name, values[i] ?? '']));
  });
}

const iso = (compact) => `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
const validCompact = (value) => /^\d{8}$/.test(value);
const asDayNumber = (isoDay) => Math.floor(Date.UTC(+isoDay.slice(0, 4), +isoDay.slice(5, 7) - 1, +isoDay.slice(8, 10)) / 86400000);
const fromDayNumber = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
const weekdayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const calendar = rows('calendar.txt');
const exceptions = rows('calendar_dates.txt');
const trips = rows('trips.txt');
if (trips === null) fail('trips.txt is missing');
if (calendar === null && exceptions === null) fail('neither calendar.txt nor calendar_dates.txt is present');

const servicesWithTrips = new Set(trips.map((trip) => trip.service_id).filter(Boolean));
const active = new Map(); // service_id -> Set of ISO days
const activeSet = (id) => { if (!active.has(id)) active.set(id, new Set()); return active.get(id); };

let declaredFirst = null;
let declaredLast = null;
const widen = (iso1) => { if (declaredFirst === null || iso1 < declaredFirst) declaredFirst = iso1; if (declaredLast === null || iso1 > declaredLast) declaredLast = iso1; };

for (const row of calendar ?? []) {
  if (!validCompact(row.start_date) || !validCompact(row.end_date)) continue;
  const start = iso(row.start_date);
  const end = iso(row.end_date);
  widen(start); widen(end);
  const pattern = weekdayNames.map((name) => row[name] === '1');
  const set = activeSet(row.service_id);
  for (let n = asDayNumber(start); n <= asDayNumber(end); n += 1) {
    if (pattern[new Date(n * 86400000).getUTCDay()]) set.add(fromDayNumber(n));
  }
}
const conflicts = new Set();
for (const row of exceptions ?? []) {
  if (!validCompact(row.date)) continue;
  const date = iso(row.date);
  widen(date);
  const set = activeSet(row.service_id);
  const key = `${row.service_id}|${date}`;
  if (row.exception_type === '1') { if (conflicts.has(key)) set.delete(date); else set.add(date); }
  else if (row.exception_type === '2') { set.delete(date); conflicts.add(key); }
}
// A removal listed with an addition for the same service and day is treated as a removal (conservative).
for (const key of conflicts) { const [id, date] = key.split('|'); activeSet(id).delete(date); }

const serviceDays = new Set();
for (const [id, days] of active) if (servicesWithTrips.has(id)) for (const d of days) serviceDays.add(d);
const ordered = [...serviceDays].sort();
const firstService = ordered[0] ?? null;
const lastService = ordered[ordered.length - 1] ?? null;

const todayNumber = asDayNumber(today);
const futureDays = ordered.filter((d) => asDayNumber(d) >= todayNumber);
const consecutiveFromToday = (() => {
  let count = 0;
  for (let n = todayNumber; serviceDays.has(fromDayNumber(n)); n += 1) count += 1;
  return count;
})();
const horizonDays = lastService === null ? null : asDayNumber(lastService) - todayNumber;

const problems = [];
if (lastService === null) problems.push('NO_EFFECTIVE_SERVICE: no service day has any trip');
if (!serviceDays.has(today)) problems.push(`NO_SERVICE_TODAY: ${today} has no service`);
if (horizonDays !== null && horizonDays < minimumFutureDays) problems.push(`HORIZON_TOO_SHORT: last service day ${lastService} is ${horizonDays} day(s) after ${today}, at least ${minimumFutureDays} required`);
if (mustCoverUntil !== '' && (lastService === null || lastService < mustCoverUntil)) problems.push(`MUST_COVER_UNTIL_NOT_MET: last service day is ${lastService}, required ${mustCoverUntil}`);

const report = {
  schema: 'gtfs-validity-report-v1',
  timezone,
  referenceDate: today,
  declared: { firstDate: declaredFirst, lastDate: declaredLast },
  effective: { firstServiceDate: firstService, lastServiceDate: lastService, serviceDaysFromToday: futureDays.length, consecutiveServiceDaysFromToday: consecutiveFromToday, horizonDaysAfterToday: horizonDays },
  trips: trips.length,
  servicesWithTrips: servicesWithTrips.size,
  requirements: { minimumFutureDays, mustCoverUntil: mustCoverUntil === '' ? null : mustCoverUntil },
  verdict: problems.length === 0 ? 'PASS' : 'FAIL',
  problems,
};
const text = `${JSON.stringify(report, null, 2)}\n`;
const out = args.get('--out');
if (out !== undefined) writeFileSync(out, text);
process.stdout.write(text);
process.exit(problems.length === 0 ? 0 : 2);
