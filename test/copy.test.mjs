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
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'client.js' });

const plugin = captured.factory(function require(name) {
  if (name === 'react') {
    return {
      createElement() {
        return null;
      },
      useState(value) {
        return [value, function () {}];
      },
      useEffect() {},
      useSyncExternalStore() {
        return undefined;
      },
    };
  }
  if (name === 'react-dom') return { createPortal() {} };
  throw new Error('unexpected require: ' + name);
});

const dicts = plugin.__dicts;
assert.ok(dicts && dicts.zh && dicts.en, 'two dictionaries');

const used = new Set();
const pattern = /(?:\bt|\.t|tr)\('([A-Za-z][A-Za-z.]*)'\)/g;
let match;
while ((match = pattern.exec(source)) !== null) {
  used.add(match[1]);
}
// Keys composed at render time from the calendar/region tables.
const pure = plugin.__pure;
for (const type of pure.CALENDAR_TYPES) used.add('calendar.' + type);
for (const type of pure.CALENDAR_TYPES) used.add('calendar.hint.' + type);
for (const id of Object.keys(pure.REGIONS)) used.add('region.' + id);
for (const day of ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']) used.add('weekday.' + day);
for (const kind of ['holiday', 'makeup', 'weekend', 'plain']) used.add('day.' + kind);

const zh = Object.keys(dicts.zh);
const en = Object.keys(dicts.en);
const missing = [];
for (const key of used) {
  if (zh.indexOf(key) === -1) missing.push('zh:' + key);
  if (en.indexOf(key) === -1) missing.push('en:' + key);
}
assert.equal(missing.length, 0, 'missing copy: ' + missing.join(', '));

const unused = zh.filter((key) => !used.has(key));
assert.equal(unused.length, 0, 'unused copy: ' + unused.join(', '));

assert.equal(zh.length, en.length, 'both dictionaries cover the same key count');
assert.equal(JSON.stringify(zh), JSON.stringify(en), 'both dictionaries expose the same keys');

const metaZh = JSON.parse(readFileSync(here + '../locale/zh.json', 'utf8'));
const metaEn = JSON.parse(readFileSync(here + '../locale/en.json', 'utf8'));
assert.equal(metaZh.meta.title, '错峰发送');
assert.equal(metaEn.meta.title, 'Off-peak send');
assert.ok(metaZh.meta.description.length > 8);
assert.ok(metaEn.meta.description.length > 8);

const manifest = JSON.parse(readFileSync(here + '../package.json', 'utf8'));
assert.equal(manifest.name, 'dsh-offpeak-sender');
assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
assert.equal(manifest.dsh.client.platform, 'web');
assert.ok(manifest.exports['./client']);
assert.ok(manifest.exports['./icon']);
assert.ok(manifest.exports['./locale/*.json']);
assert.ok(manifest.files.indexOf('client.js') !== -1);

console.log('  ok  every UI key exists in both dictionaries (' + used.size + ' keys)');
console.log('  ok  no unused dictionary entries');
console.log('  ok  plugin meta and manifest are complete');
console.log('\n3 copy checks passed');
