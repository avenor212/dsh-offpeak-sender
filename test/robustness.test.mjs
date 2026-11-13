import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const here = fileURLToPath(new URL('.', import.meta.url));
const source = readFileSync(here + '../client.js', 'utf8');

function loadPlugin() {
  let captured = null;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(options) {
          captured = options;
        },
      },
      localStorage: {
        getItem() {
          return null;
        },
        setItem() {},
        removeItem() {},
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
  return captured.factory(function require(name) {
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
}

function baseCtx(overrides) {
  const cleanups = [];
  const ctx = {
    get(name) {
      if (overrides.get) return overrides.get(name);
      return undefined;
    },
    on() {
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
      register() {
        return function () {};
      },
    },
    cleanups,
  };
  return ctx;
}

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log('  ok  ' + name);
}

check('apply survives a model catalog RPC that throws synchronously', () => {
  const plugin = loadPlugin();
  const ctx = baseCtx({
    get(name) {
      if (name === 'remote.session') {
        return {
          session: {
            modelCatalog() {
              throw new Error('connection not ready');
            },
          },
        };
      }
      return undefined;
    },
  });
  plugin.apply(ctx);
  for (const cleanup of ctx.cleanups) {
    try {
      cleanup();
    } catch (error) {}
  }
});

check('apply survives a missing conversation service', () => {
  const plugin = loadPlugin();
  const ctx = baseCtx({ get: () => undefined });
  plugin.apply(ctx);
  for (const cleanup of ctx.cleanups) {
    try {
      cleanup();
    } catch (error) {}
  }
});

check('apply survives a conversation object without sendSession', () => {
  const plugin = loadPlugin();
  const ctx = baseCtx({
    get(name) {
      if (name === 'conversation') return {};
      return undefined;
    },
  });
  plugin.apply(ctx);
  for (const cleanup of ctx.cleanups) {
    try {
      cleanup();
    } catch (error) {}
  }
});

check('apply survives a locale service that rejects registrations', () => {
  const plugin = loadPlugin();
  const ctx = baseCtx({
    get(name) {
      if (name === 'locale') {
        return {
          register() {
            throw new Error('already registered');
          },
          bind() {
            throw new Error('no namespace');
          },
        };
      }
      return undefined;
    },
  });
  plugin.apply(ctx);
  for (const cleanup of ctx.cleanups) {
    try {
      cleanup();
    } catch (error) {}
  }
});

check('apply survives a slot system that throws on every inject', () => {
  const plugin = loadPlugin();
  const ctx = baseCtx({ get: () => undefined });
  ctx.slots.inject = function () {
    throw new Error('unknown slot');
  };
  plugin.apply(ctx);
  for (const cleanup of ctx.cleanups) {
    try {
      cleanup();
    } catch (error) {}
  }
});

check('apply survives a clock that cannot start', () => {
  const plugin = loadPlugin();
  const ctx = baseCtx({ get: () => undefined });
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = function () {
    throw new Error('timer unavailable');
  };
  try {
    plugin.apply(ctx);
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  for (const cleanup of ctx.cleanups) {
    try {
      cleanup();
    } catch (error) {}
  }
});

console.log('\n' + passed + ' robustness checks passed');
