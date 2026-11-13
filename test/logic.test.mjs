import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const here = fileURLToPath(new URL('.', import.meta.url));
const source = readFileSync(here + '../client.js', 'utf8');

let captured = null;
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(options) {
        captured = options;
      },
    },
  },
  document: undefined,
  console,
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'client.js' });

assert.equal(captured && captured.id, 'dsh-offpeak-sender', 'factory id');

const ReactMock = {
  createElement() {
    return null;
  },
  useState() {
    return [undefined, function () {}];
  },
  useEffect() {},
  useMemo(value) {
    return value();
  },
  useSyncExternalStore() {
    return undefined;
  },
};

const plugin = captured.factory(function require(name) {
  if (name === 'react') return ReactMock;
  if (name === 'react-dom') return { createPortal() {} };
  throw new Error('unexpected require: ' + name);
});

assert.equal(typeof plugin.apply, 'function', 'plugin apply');
assert.equal(Array.from(plugin.inject).join(','), 'slots,conversation,remote.session', 'injected services');
const Pure = plugin.__pure;
assert.ok(Pure, 'pure helpers exposed');

const at = (hour, minute, day, month) => new Date(2026, (month || 1) - 1, day || 15, hour, minute, 0, 0).getTime();

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log('  ok  ' + name);
}

check('parseClock accepts padded and unpadded clocks', () => {
  assert.equal(Pure.parseClock('08:30'), 510);
  assert.equal(Pure.parseClock('8:05'), 485);
  assert.equal(Pure.parseClock('24:00'), 1440);
  assert.equal(Pure.parseClock('00:30'), 30);
});

check('parseClock rejects malformed clocks', () => {
  assert.equal(Pure.parseClock(''), null);
  assert.equal(Pure.parseClock('8:3'), null);
  assert.equal(Pure.parseClock('25:00'), null);
  assert.equal(Pure.parseClock('08:60'), null);
  assert.equal(Pure.parseClock(undefined), null);
  assert.equal(Pure.parseClock('abc'), null);
});

check('formatClock wraps into a day', () => {
  assert.equal(Pure.formatClock(510), '08:30');
  assert.equal(Pure.formatClock(1440), '00:00');
  assert.equal(Pure.formatClock(-30), '23:30');
});

check('same-day window excludes its end boundary', () => {
  const window = { start: '09:00', end: '18:00' };
  assert.equal(Pure.isInWindowAt(9 * 60, window), true);
  assert.equal(Pure.isInWindowAt(17 * 60 + 59, window), true);
  assert.equal(Pure.isInWindowAt(18 * 60, window), false);
  assert.equal(Pure.isInWindowAt(8 * 60 + 59, window), false);
});

check('cross-midnight window covers both ends', () => {
  const window = { start: '08:30', end: '00:30' };
  assert.equal(Pure.isInWindowAt(8 * 60 + 29, window), false);
  assert.equal(Pure.isInWindowAt(8 * 60 + 30, window), true);
  assert.equal(Pure.isInWindowAt(12 * 60, window), true);
  assert.equal(Pure.isInWindowAt(23 * 60 + 59, window), true);
  assert.equal(Pure.isInWindowAt(0, window), true);
  assert.equal(Pure.isInWindowAt(30, window), false);
});

check('empty or equal window never matches', () => {
  assert.equal(Pure.isInWindowAt(600, { start: '09:00', end: '09:00' }), false);
  assert.equal(Pure.isInWindowAt(600, {}), false);
});

check('peakWindow resolves the end of a daily window', () => {
  const index = Pure.buildCalendarIndex({});
  const windows = [{ start: '09:00', end: '18:00' }];
  const hit = Pure.peakWindow(at(10, 0), windows, 'everyday', index);
  assert.ok(hit);
  assert.equal(hit.endsAt, new Date(2026, 0, 15, 18, 0, 0, 0).getTime());
  assert.equal(Pure.peakWindow(at(19, 0), windows, 'everyday', index), null);
});

check('peakWindow resolves the end across midnight', () => {
  const index = Pure.buildCalendarIndex({});
  const windows = [{ start: '08:30', end: '00:30' }];
  const evening = Pure.peakWindow(at(23, 45), windows, 'everyday', index);
  assert.equal(evening.endsAt, new Date(2026, 0, 16, 0, 30, 0, 0).getTime());
  const afterMidnight = Pure.peakWindow(at(0, 10), windows, 'everyday', index);
  assert.equal(afterMidnight.endsAt, new Date(2026, 0, 15, 0, 30, 0, 0).getTime());
});

check('calendar data covers 2024 through 2027', () => {
  const index = Pure.buildCalendarIndex({});
  for (const year of ['2024', '2025', '2026', '2027']) {
    const entry = index.years[year];
    assert.ok(entry, 'year ' + year);
    assert.equal(entry.status, 'official', 'year ' + year + ' is official');
    assert.ok(Object.keys(entry.holidays).length >= 20, 'holidays ' + year);
    assert.ok(Object.keys(entry.makeups).length >= 3, 'make-ups ' + year);
  }
  assert.equal(index.years['2026'].holidays['2026-10-01'], '国庆节');
  assert.equal(index.years['2026'].makeups['2026-10-10'], '调休上班');
});

check('statutory workday excludes holidays and includes make-up days', () => {
  const index = Pure.buildCalendarIndex({});
  assert.equal(Pure.matchesCalendar(index, 'legalWorkday', '2026-10-01'), false, 'national day');
  assert.equal(Pure.matchesCalendar(index, 'legalWorkday', '2026-10-10'), true, 'make-up Saturday');
  assert.equal(Pure.matchesCalendar(index, 'legalWorkday', '2026-10-11'), false, 'ordinary Sunday');
  assert.equal(Pure.matchesCalendar(index, 'legalWorkday', '2026-10-12'), true, 'ordinary Monday');
  assert.equal(Pure.matchesCalendar(index, 'legalWorkday', '2026-02-17'), false, 'spring festival');
});

check('statutory holiday type mirrors the workday table', () => {
  const index = Pure.buildCalendarIndex({});
  assert.equal(Pure.matchesCalendar(index, 'legalHoliday', '2026-10-01'), true);
  assert.equal(Pure.matchesCalendar(index, 'legalHoliday', '2026-10-10'), false, 'make-up Saturday');
  assert.equal(Pure.matchesCalendar(index, 'legalHoliday', '2026-10-11'), true, 'ordinary Sunday');
});

check('weekday and weekend ignore the holiday table', () => {
  const index = Pure.buildCalendarIndex({});
  assert.equal(Pure.matchesCalendar(index, 'weekday', '2026-10-10'), false, 'Saturday stays weekend');
  assert.equal(Pure.matchesCalendar(index, 'weekend', '2026-10-10'), true);
  assert.equal(Pure.matchesCalendar(index, 'weekday', '2026-10-01'), true, 'Thursday stays weekday');
  assert.equal(Pure.matchesCalendar(index, 'everyday', '2026-10-01'), true);
});

check('peakWindow combines the calendar rule with the windows', () => {
  const index = Pure.buildCalendarIndex({});
  const windows = [
    { start: '08:00', end: '12:00' },
    { start: '14:00', end: '18:00' },
  ];
  assert.equal(Pure.peakWindow(at(10, 0, 1, 10), windows, 'legalWorkday', index), null, 'holiday');
  const morning = Pure.peakWindow(at(10, 0, 12, 10), windows, 'legalWorkday', index);
  assert.ok(morning, 'workday morning');
  assert.equal(morning.endsAt, new Date(2026, 9, 12, 12, 0, 0, 0).getTime());
  assert.equal(Pure.peakWindow(at(13, 0, 12, 10), windows, 'legalWorkday', index), null, 'lunch break');
  assert.ok(Pure.peakWindow(at(15, 0, 12, 10), windows, 'legalWorkday', index), 'workday afternoon');
  assert.equal(Pure.peakWindow(at(19, 0, 12, 10), windows, 'legalWorkday', index), null, 'evening');
});

check('a cross-midnight window belongs to its start day', () => {
  const index = Pure.buildCalendarIndex({});
  const windows = [{ start: '22:00', end: '06:00' }];
  // 2026-10-08 is the first workday after the national holiday.
  const evening = Pure.peakWindow(at(23, 0, 8, 10), windows, 'legalWorkday', index);
  assert.ok(evening, 'workday late evening');
  assert.equal(evening.anchorDate, '2026-10-08');
  assert.equal(evening.endsAt, new Date(2026, 9, 9, 6, 0, 0, 0).getTime());
  const smallHours = Pure.peakWindow(at(1, 0, 9, 10), windows, 'legalWorkday', index);
  assert.ok(smallHours, 'carried into the next day');
  assert.equal(smallHours.anchorDate, '2026-10-08');
  // 2026-10-07 is still inside the national holiday.
  assert.equal(Pure.peakWindow(at(23, 0, 7, 10), windows, 'legalWorkday', index), null);
  assert.equal(Pure.peakWindow(at(1, 0, 8, 10), windows, 'legalWorkday', index), null);
});

check('missing years fall back to plain weekday rules', () => {
  const index = Pure.buildCalendarIndex({});
  assert.equal(Pure.matchesCalendar(index, 'legalWorkday', '2029-06-04'), true, 'Monday');
  assert.equal(Pure.matchesCalendar(index, 'legalHoliday', '2029-06-03'), true, 'Sunday');
  assert.equal(Pure.matchesCalendar(index, 'legalWorkday', '2029-06-03'), false);
});

check('custom holiday data wins over the built-in table', () => {
  const custom = Pure.buildCalendarIndex({
    '2026': { holidaysText: '2026-10-08 自定义假日', makeupsText: '2026-10-09' },
  });
  assert.equal(custom.years['2026'].status, 'custom');
  assert.equal(Pure.matchesCalendar(custom, 'legalHoliday', '2026-10-08'), true);
  assert.equal(Pure.matchesCalendar(custom, 'legalWorkday', '2026-10-09'), true);
  // Built-in entries survive an override that only adds days.
  assert.equal(Pure.matchesCalendar(custom, 'legalHoliday', '2026-10-01'), true);
});

check('date lines round-trip', () => {
  const parsed = Pure.parseDateLines('2026-10-01 国庆节\n2026-10-02 国庆节\n2026-10-09');
  assert.equal(parsed['2026-10-01'], '国庆节');
  assert.equal(parsed['2026-10-09'], 'holiday');
  const formatted = Pure.formatDateLines(parsed);
  assert.ok(formatted.indexOf('2026-10-01 国庆节') !== -1);
  assert.ok(formatted.indexOf('2026-10-09') !== -1);
});

check('untouched v1 defaults migrate to the statutory-workday rule', () => {
  const migrated = Pure.normalizeConfig({
    version: 1,
    groups: [
      { id: 'default', provider: '*', model: '*', enabled: true, windows: [{ start: '08:30', end: '00:30' }] },
    ],
  });
  assert.equal(migrated.groups[0].calendar, 'legalWorkday');
  assert.equal(migrated.groups[0].windows.length, 2);
});

check('edited v1 rules keep their own windows and become everyday', () => {
  const kept = Pure.normalizeConfig({
    version: 1,
    groups: [
      { id: 'mine', provider: 'deepseek', model: 'deepseek-chat', windows: [{ start: '09:00', end: '17:00' }] },
    ],
  });
  assert.equal(kept.groups[0].calendar, 'everyday');
  assert.equal(kept.groups[0].windows[0].start, '09:00');
  assert.equal(kept.groups[0].windows.length, 1);
});

check('default config is a statutory-workday rule with two windows', () => {
  const config = Pure.defaultConfig();
  const group = config.groups[0];
  assert.equal(group.calendar, 'legalWorkday');
  assert.equal(group.region, 'cn');
  assert.equal(
    JSON.stringify(group.windows),
    JSON.stringify([
      { start: '08:00', end: '12:00' },
      { start: '14:00', end: '18:00' },
    ])
  );
});

check('matchGroup honours wildcards and case', () => {
  const groups = [
    { id: 'a', provider: '*', model: '*', enabled: true, windows: [] },
  ];
  assert.equal(Pure.matchGroup(groups, { provider: 'deepseek', model: 'deepseek-chat' }), groups[0]);
  assert.equal(Pure.matchGroup(groups, null), groups[0]);
});

check('matchGroup prefers the first enabled specific row', () => {
  const groups = [
    { id: 'off', provider: 'deepseek', model: 'deepseek-chat', enabled: false, windows: [] },
    { id: 'chat', provider: 'DeepSeek', model: 'DeepSeek-Chat', enabled: true, windows: [] },
    { id: 'wild', provider: '*', model: '*', enabled: true, windows: [] },
  ];
  const hit = Pure.matchGroup(groups, { provider: 'deepseek', model: 'deepseek-chat' });
  assert.equal(hit.id, 'chat');
  assert.equal(Pure.matchGroup(groups, { provider: 'other', model: 'x' }).id, 'wild');
});

check('matchGroup does not match a concrete model when the model is unknown', () => {
  const groups = [{ id: 'chat', provider: 'deepseek', model: 'deepseek-chat', enabled: true, windows: [] }];
  assert.equal(Pure.matchGroup(groups, null), null);
  assert.equal(Pure.matchGroup(groups, { provider: 'deepseek', model: 'deepseek-reasoner' }), null);
});

check('normalizeConfig keeps a valid shape', () => {
  const config = Pure.normalizeConfig({
    enabled: false,
    strategy: 'merge',
    groups: [
      { id: 'g', provider: 'deepseek', model: 'm', windows: [{ start: '1:00', end: '2:00' }] },
    ],
  });
  assert.equal(config.enabled, false);
  assert.equal(config.strategy, 'merge');
  assert.equal(config.groups.length, 1);
  assert.equal(config.groups[0].id, 'g');
  assert.equal(config.groups[0].windows[0].start, '1:00');
  assert.equal(config.groups[0].calendar, 'everyday', 'missing calendar falls back to everyday');
  assert.equal(config.groups[0].region, 'cn');
});

check('normalizeConfig rejects garbage and keeps empty groups', () => {
  const fallback = Pure.normalizeConfig(null);
  assert.equal(fallback.strategy, 'sequential');
  assert.equal(fallback.groups.length, 1);
  const empty = Pure.normalizeConfig({ groups: [] });
  assert.equal(empty.groups.length, 0);
});

check('normalizeConfig gives duplicated ids fresh ones', () => {
  const config = Pure.normalizeConfig({
    groups: [
      { id: 'same', windows: [] },
      { id: 'same', windows: [] },
    ],
  });
  assert.equal(config.groups.length, 2);
  assert.equal(config.groups[0].id, 'same');
  assert.notEqual(config.groups[1].id, 'same');
});

check('normalizeQueue drops invalid rows', () => {
  const queue = Pure.normalizeQueue({
    s1: [
      { id: 'a', text: 'hello', mode: 'steer', attachments: ['x', 3] },
      { text: 'no id' },
      null,
      { id: 'bad' },
    ],
    s2: 'nope',
  });
  assert.deepEqual(Object.keys(queue), ['s1']);
  assert.equal(queue.s1.length, 2);
  assert.equal(queue.s1[0].id, 'a');
  assert.equal(queue.s1[0].mode, 'steer');
  assert.equal(JSON.stringify(queue.s1[0].attachments), JSON.stringify(['x']));
  assert.equal(typeof queue.s1[1].id, 'string');
  assert.equal(queue.s1[1].mode, 'queue');
});

check('mergeTexts joins trimmed texts and skips blanks', () => {
  assert.equal(Pure.mergeTexts([{ text: ' a ' }, { text: '' }, { text: 'b' }]), 'a\n\nb');
  assert.equal(Pure.mergeTexts([]), '');
});

check('durationParts splits hours, minutes, seconds', () => {
  assert.equal(
    JSON.stringify(Pure.durationParts(3 * 3600000 + 12 * 60000 + 5000)),
    JSON.stringify({ hours: 3, minutes: 12, seconds: 5 })
  );
  assert.equal(
    JSON.stringify(Pure.durationParts(-1000)),
    JSON.stringify({ hours: 0, minutes: 0, seconds: 0 })
  );
});

check('findGroup matches by id', () => {
  const groups = [{ id: 'a' }, { id: 'b' }];
  assert.equal(Pure.findGroup(groups, 'b'), groups[1]);
  assert.equal(Pure.findGroup(groups, 'c'), null);
  assert.equal(Pure.findGroup(null, 'a'), null);
});

console.log('\n' + passed + ' checks passed');
