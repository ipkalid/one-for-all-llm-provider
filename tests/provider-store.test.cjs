const assert = require('node:assert/strict');
const test = require('node:test');

const {ProviderStore} = require('../out/provider-store.js');

class Secrets {
  values = new Map();

  get(key) {
    return Promise.resolve(this.values.get(key));
  }

  store(key, value) {
    this.values.set(key, value);
    return Promise.resolve();
  }

  delete(key) {
    this.values.delete(key);
    return Promise.resolve();
  }
}

class State {
  values = new Map();

  get(key, fallback) {
    return this.values.has(key) ? this.values.get(key) : fallback;
  }

  update(key, value) {
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
    return Promise.resolve();
  }
}

test('stores provider credentials in secrets and model choices in state', async () => {
  const secrets = new Secrets();
  const state = new State();
  const store = new ProviderStore(secrets, state);

  await store.saveConnection('openrouter', {
    credentials: {OPENROUTER_API_KEY: 'secret'},
    adapter: 'catalog',
    baseURL: 'https://openrouter.ai/api/v1',
  });
  await store.setEnabledModelIds('openrouter', ['model-b', 'model-a']);

  assert.deepEqual(store.getConfiguredProviderIds(), ['openrouter']);
  assert.deepEqual(store.getEnabledModelIds('openrouter'), [
    'model-a',
    'model-b',
  ]);
  assert.deepEqual(await store.getConnection('openrouter'), {
    credentials: {OPENROUTER_API_KEY: 'secret'},
    adapter: 'catalog',
    baseURL: 'https://openrouter.ai/api/v1',
  });

  await store.removeProvider('openrouter');
  assert.deepEqual(store.getConfiguredProviderIds(), []);
  assert.equal(await store.getConnection('openrouter'), undefined);
});
