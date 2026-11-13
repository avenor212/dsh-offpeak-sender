import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const here = fileURLToPath(new URL('.', import.meta.url));
const source = readFileSync(here + '../client.js', 'utf8');

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

const ReactMock = {
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

const plugin = captured.factory(function require(name) {
  if (name === 'react') return ReactMock;
  if (name === 'react-dom') return { createPortal() {} };
  throw new Error('unexpected require: ' + name);
});

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log('  ok  ' + name);
}

/** A peak window that certainly covers "now". */
function coveringWindow() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const later = new Date(now.getTime() + 30 * 60000);
  return {
    start: pad(now.getHours()) + ':' + pad(now.getMinutes()),
    end: pad(later.getHours()) + ':' + pad(later.getMinutes()),
  };
}

const covering = coveringWindow();

storage['dsh.offpeak-sender.config.v1'] = JSON.stringify({
  version: 1,
  enabled: true,
  strategy: 'sequential',
  groups: [{ id: 'g1', provider: '*', model: '*', enabled: true, windows: [covering] }],
});

class FakeConversation {
  constructor() {
    this.calls = [];
  }
  sendSession(session, text, attachmentIds, mode) {
    this.calls.push({ session: session, text: text, attachmentIds: attachmentIds, mode: mode });
    return Promise.resolve({ kind: 'success' });
  }
}

const conversation = new FakeConversation();
const originalPrototypeMethod = FakeConversation.prototype.sendSession;
const fakeSession = {
  sessionId: 's1',
  projections: {
    faceOf() {
      return {
        getSnapshot() {
          return { next: { provider: 'deepseek', model: 'deepseek-chat' } };
        },
      };
    },
  },
  getSnapshot() {
    return { running: false, sessionId: 's1' };
  },
  prompt() {
    return Promise.resolve({ ok: true });
  },
};

const references = [];
const sessions = {
  retain(id) {
    const reference = {
      binding: { session: fakeSession },
      released: false,
      release() {
        this.released = true;
      },
    };
    references.push({ id: id, reference: reference });
    return reference;
  },
};

const locale = {
  register() {
    return function () {};
  },
  bind() {
    return function (key) {
      return key;
    };
  },
};

const registered = [];
const cleanups = [];
const catalogGroups = [
  {
    id: 'deepseek-account',
    name: 'DeepSeek Account',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    ],
  },
  { id: 'empty-provider', name: 'Empty Provider', models: [] },
];
const remote = {
  session: {
    modelCatalog() {
      return Promise.resolve({ ok: true, value: { groups: catalogGroups } });
    },
  },
};
const ctx = {
  get(name) {
    if (name === 'conversation') return conversation;
    if (name === 'sessions') return sessions;
    if (name === 'locale') return locale;
    if (name === 'remote.session') return remote.session;
    if (name === 'remote') return remote;
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
assert.ok(runtime, 'runtime exposed for diagnostics');

const names = registered.map((entry) => entry.options.name).sort();

await check('loads the host model catalog for the pickers', async () => {
  runtime.ensureCatalog(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const catalog = runtime.store.get().catalog;
  assert.equal(catalog.status, 'ready');
  assert.equal(catalog.providers.length, 2);
  assert.equal(catalog.providers[0].id, 'deepseek-account');
  assert.equal(catalog.providers[0].name, 'DeepSeek Account');
  assert.equal(catalog.providers[0].models.length, 2);
  assert.equal(catalog.providers[0].models[0].id, 'deepseek-chat');
  assert.equal(catalog.providers[1].models.length, 0);
});

await check('registers every slot exactly once', () => {
  assert.equal(JSON.stringify(names), JSON.stringify([
    'conversation.input.dock',
    'settings.section',
    'settings.section.icon',
    'shell.overlay',
  ]));
});

await check('queues instead of sending while the window covers now', async () => {
  const pending = conversation.sendSession(fakeSession, 'queued text', [], 'queue');
  assert.equal(conversation.calls.length, 0, 'original was not called');
  assert.equal(runtime.store.get().confirms.length, 1, 'one confirmation is waiting');
  const confirmId = runtime.store.get().confirms[0].id;
  runtime.resolveConfirm(confirmId, 'later');
  const outcome = await pending;
  assert.equal(outcome.kind, 'success');
  assert.equal(runtime.store.get().confirms.length, 0);
  assert.equal(runtime.store.get().queues.s1.length, 1);
  assert.equal(runtime.store.get().queues.s1[0].text, 'queued text');
});

await check('send-now forwards to the original method', async () => {
  conversation.calls.length = 0;
  const pending = conversation.sendSession(fakeSession, 'send now', [], 'queue');
  assert.equal(conversation.calls.length, 0);
  runtime.resolveConfirm(runtime.store.get().confirms[0].id, 'now');
  const outcome = await pending;
  assert.equal(outcome.kind, 'success');
  assert.equal(conversation.calls.length, 1);
  assert.equal(conversation.calls[0].text, 'send now');
});

await check('discard resolves an error outcome and keeps no queue row', async () => {
  const before = runtime.store.get().queues.s1.length;
  const pending = conversation.sendSession(fakeSession, 'discard me', [], 'queue');
  runtime.resolveConfirm(runtime.store.get().confirms[0].id, 'cancel');
  const outcome = await pending;
  assert.equal(outcome.kind, 'error');
  assert.equal(typeof outcome.text, 'string');
  assert.equal(runtime.store.get().queues.s1.length, before);
});

await check('passes through when disabled', async () => {
  runtime.patchConfig({ enabled: false });
  conversation.calls.length = 0;
  const outcome = await conversation.sendSession(fakeSession, 'no guard', [], 'queue');
  assert.equal(outcome.kind, 'success');
  assert.equal(conversation.calls.length, 1);
  runtime.patchConfig({ enabled: true });
});

await check('passes through when no group matches the model', async () => {
  runtime.mutateConfig(function (config) {
    return Object.assign({}, config, {
      groups: [{ id: 'g2', provider: 'other', model: 'other', enabled: true, windows: [covering] }],
    });
  });
  conversation.calls.length = 0;
  await conversation.sendSession(fakeSession, 'other model', [], 'queue');
  assert.equal(conversation.calls.length, 1);
});

await check('pump releases the queue once off-peak', async () => {
  runtime.mutateConfig(function (config) {
    return Object.assign({}, config, {
      groups: [{ id: 'g1', provider: '*', model: '*', enabled: true, windows: [] }],
    });
  });
  conversation.calls.length = 0;
  await runtime.pump();
  assert.equal(conversation.calls.length, 1);
  assert.equal(conversation.calls[0].text, 'queued text');
  assert.equal(runtime.store.get().queues.s1, undefined);
});

await check('merge strategy joins text-only rows', async () => {
  runtime.mutateConfig(function (config) {
    return Object.assign({}, config, { strategy: 'merge', groups: [] });
  });
  runtime.store.update(function (state) {
    return Object.assign({}, state, {
      queues: {
        s2: [
          { id: 'a', text: 'first', attachments: [], mode: 'queue', groupId: 'g1', createdAt: 1, error: '' },
          { id: 'b', text: 'second', attachments: [], mode: 'queue', groupId: 'g1', createdAt: 2, error: '' },
        ],
      },
    });
  });
  conversation.calls.length = 0;
  await runtime.pump();
  assert.equal(conversation.calls.length, 1);
  assert.equal(conversation.calls[0].text, 'first\n\nsecond');
  assert.equal(runtime.store.get().queues.s2, undefined);
});

await check('the calendar rule gates interception', async () => {
  const dow = new Date().getDay();
  const weekend = dow === 0 || dow === 6;
  const hitType = weekend ? 'weekend' : 'weekday';
  const missType = weekend ? 'weekday' : 'weekend';
  runtime.patchConfig({ enabled: true });
  runtime.mutateConfig((config) =>
    Object.assign({}, config, {
      groups: [
        {
          id: 'g1',
          provider: '*',
          model: '*',
          enabled: true,
          calendar: hitType,
          windows: [covering],
        },
      ],
    })
  );
  const pending = conversation.sendSession(fakeSession, 'calendar hit', [], 'queue');
  assert.equal(runtime.store.get().confirms.length, 1, 'matching calendar day is guarded');
  runtime.resolveConfirm(runtime.store.get().confirms[0].id, 'cancel');
  await pending;

  runtime.mutateConfig((config) =>
    Object.assign({}, config, {
      groups: [
        {
          id: 'g1',
          provider: '*',
          model: '*',
          enabled: true,
          calendar: missType,
          windows: [covering],
        },
      ],
    })
  );
  conversation.calls.length = 0;
  await conversation.sendSession(fakeSession, 'calendar miss', [], 'queue');
  assert.equal(conversation.calls.length, 1, 'other calendar day passes through');
  runtime.mutateConfig((config) =>
    Object.assign({}, config, {
      groups: [{ id: 'g1', provider: '*', model: '*', enabled: true, windows: [covering] }],
    })
  );
});

await check('records a failed attempt and stops retrying after three', async () => {
  runtime.mutateConfig((config) => Object.assign({}, config, { strategy: 'sequential', groups: [] }));
  runtime.markItemError('s3', 'x', 'boom');
  const item = {
    id: 'x',
    text: 'fails',
    attachments: [],
    mode: 'queue',
    groupId: 'g1',
    createdAt: 1,
    error: 'boom',
    attempts: 3,
  };
  runtime.store.update((state) => Object.assign({}, state, { queues: { s3: [item] } }));
  conversation.calls.length = 0;
  await runtime.pump();
  assert.equal(conversation.calls.length, 0, 'exhausted row is not retried');
  assert.equal(runtime.isSendable(item), false);
  runtime.clearItemError('s3', 'x');
  assert.equal(runtime.isSendable(runtime.store.get().queues.s3[0]), true);
  await runtime.pump();
  assert.equal(conversation.calls.length, 1, 'retried after the reset');
  assert.equal(runtime.store.get().queues.s3, undefined);
});

await check('teardown restores the prototype method', () => {
  const proto = Object.getPrototypeOf(conversation);
  assert.notEqual(proto.sendSession, originalPrototypeMethod);
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {}
  }
  assert.equal(proto.sendSession, originalPrototypeMethod);
});

console.log('\n' + passed + ' runtime checks passed');
