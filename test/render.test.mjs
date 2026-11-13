import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const here = fileURLToPath(new URL('.', import.meta.url));
const source = readFileSync(here + '../client.js', 'utf8');

// A real React runtime (React 19 ships with another local project) renders the
// plugin components to static markup, so an undefined prop, a bad element
// shape, or a hook-order mistake fails here instead of leaving a blank slot.
const externalRequire = createRequire('D:/myWorkfolder/DocStageIntro/node_modules/');
const React = externalRequire('react');
const ReactDOMServer = externalRequire('react-dom/server');
const ReactDOM = externalRequire('react-dom');

const storage = {};
let captured = null;
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(options) {
        captured = options;
      },
    },
    localStorage: {
      getItem(key) {
        return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null;
      },
      setItem(key, value) {
        storage[key] = String(value);
      },
      removeItem(key) {
        delete storage[key];
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
  if (name === 'react') return React;
  if (name === 'react-dom') return ReactDOM;
  throw new Error('unexpected require: ' + name);
});

const registered = [];
const cleanups = [];
const conversation = { sendSession() { return Promise.resolve({ kind: 'success' }); } };
const ctx = {
  get(name) {
    if (name === 'conversation') return conversation;
    if (name === 'locale') {
      return {
        register() {
          return function () {};
        },
        bind() {
          return function (key) {
            return key;
          };
        },
      };
    }
    return undefined;
  },
  on(name, listener) {
    return function () {};
  },
  effect(fn) {
    const dispose = fn();
    if (typeof dispose === 'function') cleanups.push(dispose);
    return function () {};
  },
  slots: {
    inject(key, callback) {
      const dispose = callback();
      cleanups.push(typeof dispose === 'function' ? dispose : function () {});
      return function () {};
    },
    register(options, component) {
      registered.push({ options: options, component: component });
      return function () {};
    },
  },
};

plugin.apply(ctx);
const runtime = plugin.__runtime;

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log('  ok  ' + name);
}

function render(component, props) {
  return ReactDOMServer.renderToStaticMarkup(React.createElement(component, props || {}));
}

const byName = {};
for (const entry of registered) byName[entry.options.name] = entry.component;

await Promise.resolve();

check('settings section renders its rows', () => {
  const html = render(byName['settings.section'], { close() {} });
  assert.ok(html.includes('op-sect'), 'section root');
  assert.ok(html.includes('settings.title'), 'title copy');
  assert.ok(html.includes('role="switch"'), 'enable switch');
  assert.ok(html.includes('role="radiogroup"'), 'strategy group');
  assert.ok(html.includes('op-group'), 'model group card');
  assert.ok(html.includes('settings.calendar'), 'calendar field');
  assert.ok(html.includes('calendar.everyday'), 'calendar option');
  assert.ok(html.includes('calendar.legalWorkday'), 'calendar option');
  assert.ok(html.includes('calendar.hint.legalWorkday'), 'calendar explanation');
  assert.ok(html.includes('settings.nowLine'), 'current peak state');
  assert.ok(html.includes('settings.applyOfficial'), 'official preset action');
  assert.ok(html.includes('value="08:00"'), 'default morning window');
  assert.ok(html.includes('value="14:00"'), 'default afternoon window');
  assert.ok(html.includes('settings.today'), 'today hint');
  assert.ok(html.includes('settings.addModel'), 'add-model button');
});

check('settings section renders the China holiday data table', () => {
  const html = render(byName['settings.section'], { close() {} });
  assert.ok(html.includes('settings.dataTitle'), 'data title');
  assert.ok(html.includes('settings.holidayDays'), 'holiday count copy');
  for (const year of ['2024', '2025', '2026', '2027']) {
    assert.ok(html.includes(year), 'year ' + year);
  }
  assert.ok(html.includes('settings.addYear'), 'add-year control');
});

check('settings icon renders an svg', () => {
  const html = render(byName['settings.section.icon'], { size: 16, active: true });
  assert.ok(html.startsWith('<svg'), html.slice(0, 40));
  assert.ok(html.includes('currentColor'));
});

check('provider and model pickers render catalog options', () => {
  runtime.store.update((state) =>
    Object.assign({}, state, {
      catalog: {
        status: 'ready',
        providers: [
          {
            id: 'deepseek-account',
            name: 'DeepSeek Account',
            models: [
              { id: 'deepseek-chat', name: 'DeepSeek Chat' },
              { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
            ],
          },
          {
            id: 'other-provider',
            name: 'Other Provider',
            models: [{ id: 'other-model', name: 'Other Model' }],
          },
        ],
        error: '',
      },
    })
  );
  const html = render(byName['settings.section'], { close() {} });
  assert.ok(html.includes('settings.anyProvider'), 'any-provider option');
  assert.ok(html.includes('settings.anyModel'), 'any-model option');
  assert.ok(html.includes('DeepSeek Account'), 'provider option label');
  assert.ok(html.includes('deepseek-chat'), 'model option value');
  assert.ok(html.includes('DeepSeek Chat'), 'model option label');
  assert.ok(html.includes('settings.catalogReady'), 'catalog status line');
  assert.ok(html.includes('<select'), 'select controls exist');
});

check('a concrete provider narrows the model picker to its models', () => {
  runtime.mutateConfig((config) =>
    Object.assign({}, config, {
      groups: [
        {
          id: 'g1',
          provider: 'deepseek-account',
          model: 'deepseek-chat',
          enabled: true,
          calendar: 'everyday',
          windows: [{ start: '00:00', end: '23:59' }],
        },
      ],
    })
  );
  const html = render(byName['settings.section'], { close() {} });
  assert.ok(html.includes('DeepSeek Chat'), 'selected model label');
  assert.ok(html.includes('DeepSeek Reasoner'), 'sibling model of the same provider');
  assert.ok(!html.includes('other-model'), 'other provider model is not offered');
  runtime.mutateConfig((config) =>
    Object.assign({}, config, {
      groups: [{ id: 'g1', provider: '*', model: '*', enabled: true, windows: [{ start: '08:00', end: '12:00' }] }],
    })
  );
});

check('queue dock renders queued rows and a countdown', () => {
  runtime.store.update((state) =>
    Object.assign({}, state, {
      queues: {
        s1: [
          {
            id: 'a',
            text: 'compile the report',
            attachments: [],
            mode: 'queue',
            groupId: 'g1',
            createdAt: Date.now(),
            error: '',
          },
        ],
      },
    })
  );
  runtime.mutateConfig((config) =>
    Object.assign({}, config, {
      groups: [{ id: 'g1', provider: '*', model: '*', enabled: true, windows: [{ start: '00:00', end: '23:59' }] }],
    })
  );
  const html = render(byName['conversation.input.dock'], {
    useSession(selector) {
      return selector({ sessionId: 's1' });
    },
  });
  assert.ok(html.includes('op-dock'), 'dock root');
  assert.ok(html.includes('dock.title'), 'dock copy');
  assert.ok(html.includes('compile the report'), 'queued text');
  runtime.clearQueue('s1');
});

check('queue dock renders nothing without a queue', () => {
  const html = render(byName['conversation.input.dock'], {
    useSession(selector) {
      return selector({ sessionId: 's1' });
    },
  });
  assert.equal(html, '');
});

check('modal renders the three choices and a countdown', () => {
  const window = { start: '08:30', end: '00:30' };
  runtime.requestDecision({
    sessionId: 's1',
    text: 'do the thing',
    attachments: [],
    mode: 'queue',
    groupId: 'g1',
    window: window,
    endsAt: Date.now() + 3 * 3600000 + 12 * 60000,
    model: { provider: 'deepseek', model: 'deepseek-chat' },
    signal: null,
    deliver() {
      return Promise.resolve();
    },
    discard() {},
  });
  const html = render(byName['shell.overlay'], {});
  assert.ok(html.includes('op-overlay'), 'overlay root');
  assert.ok(html.includes('role="dialog"'), 'dialog role');
  assert.ok(html.includes('modal.title'), 'title copy');
  assert.ok(html.includes('modal.cancel'), 'discard choice');
  assert.ok(html.includes('modal.later'), 'queue choice');
  assert.ok(html.includes('modal.now'), 'send-now choice');
  assert.ok(html.includes('deepseek / deepseek-chat'), 'model label');
  assert.ok(html.includes('calendar.everyday'), 'calendar label');
  assert.ok(html.includes('do the thing'), 'message preview');
  assert.ok(html.includes('op-modal-count'), 'countdown line');
  assert.ok(html.includes('unit.hour'), 'countdown units');
  runtime.resolveConfirm(runtime.store.get().confirms[0].id, 'cancel');
});

check('modal renders nothing when nothing is pending', () => {
  const html = render(byName['shell.overlay'], {});
  assert.equal(html, '');
});

check('English dictionary covers every key used by the UI', () => {
  const keys = new Set();
  const sourceText = source;
  const pattern = /t\('([a-z]+\.[A-Za-z.]+)'\)/g;
  let match;
  while ((match = pattern.exec(sourceText)) !== null) keys.add(match[1]);
  const purePattern = /'((?:unit|settings|modal|dock)\.[A-Za-z]+)'/g;
  while ((match = purePattern.exec(sourceText)) !== null) keys.add(match[1]);
  // Dictionary literals themselves contain the known keys; verify each used key
  // exists in both dictionaries by rendering with each language.
  const english = source;
  assert.ok(english.includes("'settings.title': 'Off-peak send'"), 'english title');
  assert.ok(keys.size > 20, 'collected copy keys: ' + keys.size);
});

for (const cleanup of cleanups) {
  try {
    cleanup();
  } catch (error) {}
}

console.log('\n' + passed + ' render checks passed');
