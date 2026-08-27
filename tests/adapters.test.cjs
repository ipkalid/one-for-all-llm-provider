const assert = require('node:assert/strict');
const test = require('node:test');
const {streamText} = require('ai');

const {resolveModelAdapter} = require('../out/adapters.js');

const model = {
  id: 'test-model',
  name: 'Test Model',
  description: 'Test',
  attachment: false,
  reasoning: false,
  reasoning_options: [],
  tool_call: true,
  release_date: '2026-01',
  last_updated: '2026-01',
  modalities: {input: ['text'], output: ['text']},
  limit: {context: 1000, output: 100},
};

test('constructs a catalog-selected OpenAI-compatible model adapter', () => {
  const provider = {
    id: 'test-provider',
    name: 'Test Provider',
    npm: '@ai-sdk/openai-compatible',
    env: ['TEST_API_KEY'],
    api: 'https://example.test/v1',
    doc: 'https://example.test/docs',
    models: {'test-model': model},
  };
  const adapter = resolveModelAdapter(provider, model, {
    credentials: {TEST_API_KEY: 'secret'},
    adapter: 'catalog',
  });

  assert.equal(adapter.packageName, '@ai-sdk/openai-compatible');
  assert.equal(adapter.languageModel.modelId, 'test-model');
  assert.equal(adapter.languageModel.provider, 'test-provider.chat');
});

test('allows unknown catalog packages through an explicit compatible endpoint', () => {
  const provider = {
    id: 'custom-provider',
    name: 'Custom Provider',
    npm: 'custom-ai-sdk',
    env: [],
    doc: 'https://example.test/docs',
    models: {'test-model': model},
  };
  const adapter = resolveModelAdapter(provider, model, {
    credentials: {},
    adapter: 'openai-compatible',
    baseURL: 'http://127.0.0.1:11434/v1',
  });

  assert.equal(adapter.packageName, '@ai-sdk/openai-compatible');
  assert.equal(adapter.languageModel.modelId, 'test-model');
});

test('requires an endpoint for an Anthropic override on an unknown provider', () => {
  const provider = {
    id: 'custom-provider',
    name: 'Custom Provider',
    npm: 'custom-ai-sdk',
    env: ['CUSTOM_API_KEY'],
    doc: 'https://example.test/docs',
    models: {'test-model': model},
  };

  assert.throws(
    () =>
      resolveModelAdapter(provider, model, {
        credentials: {CUSTOM_API_KEY: 'secret'},
        adapter: 'anthropic',
      }),
    /needs an Anthropic-compatible base URL/,
  );
});

test('uses the Responses API for catalog models with a responses shape', () => {
  const provider = {
    id: 'responses-provider',
    name: 'Responses Provider',
    npm: '@ai-sdk/openai-compatible',
    env: ['RESPONSES_API_KEY'],
    api: 'https://example.test/v1',
    doc: 'https://example.test/docs',
    models: {'test-model': {...model, provider: {shape: 'responses'}}},
  };
  const responseModel = provider.models['test-model'];
  const adapter = resolveModelAdapter(provider, responseModel, {
    credentials: {RESPONSES_API_KEY: 'secret'},
    adapter: 'catalog',
  });

  assert.equal(adapter.packageName, '@ai-sdk/openai');
  assert.equal(adapter.languageModel.provider, 'responses-provider.responses');
});

test('keeps model overrides inside the Cloudflare AI Gateway', () => {
  const provider = {
    id: 'cloudflare-ai-gateway',
    name: 'Cloudflare AI Gateway',
    npm: 'ai-gateway-provider',
    env: [
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_GATEWAY_ID',
    ],
    doc: 'https://developers.cloudflare.com/ai-gateway/',
    models: {
      'anthropic/test-model': {
        ...model,
        id: 'anthropic/test-model',
        provider: {npm: '@ai-sdk/anthropic'},
      },
    },
  };
  const gatewayModel = provider.models['anthropic/test-model'];
  const adapter = resolveModelAdapter(provider, gatewayModel, {
    credentials: {
      CLOUDFLARE_API_TOKEN: 'secret',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_GATEWAY_ID: 'gateway',
    },
    adapter: 'catalog',
  });

  assert.equal(adapter.packageName, 'ai-gateway-provider');
  assert.equal(adapter.languageModel.modelId, 'anthropic/test-model');
});

test('constructs lightweight catalog adapters for specialized compatible providers', () => {
  const cases = [
    {
      id: 'qvac',
      npm: '@qvac/ai-sdk-provider',
      env: ['QVAC_API_KEY'],
    },
    {
      id: 'aihubmix',
      npm: '@aihubmix/ai-sdk-provider',
      env: ['AIHUBMIX_API_KEY'],
    },
    {
      id: 'venice',
      npm: 'venice-ai-sdk-provider',
      env: ['VENICE_API_KEY'],
    },
    {
      id: 'salad-cloud',
      npm: '@saladtechnologies-oss/ai-sdk-provider',
      env: ['SALAD_CLOUD_API_KEY'],
    },
  ];

  for (const item of cases) {
    const provider = {
      ...item,
      name: item.id,
      doc: 'https://example.test/docs',
      models: {'test-model': model},
    };
    const adapter = resolveModelAdapter(provider, model, {
      credentials: {[item.env[0]]: 'secret'},
      adapter: 'catalog',
    });
    assert.equal(adapter.languageModel.modelId, 'test-model');
  }
});

test('streams a catalog-selected compatible model through its configured endpoint', async () => {
  let receivedURL;
  let receivedBody;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    receivedURL = String(input);
    receivedBody = JSON.parse(String(init.body));
    return new Response(
      [
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
        'data: [DONE]',
        '',
      ].join('\n\n'),
      {headers: {'content-type': 'text/event-stream'}},
    );
  };

  try {
    const provider = {
      id: 'local-provider',
      name: 'Local Provider',
      npm: '@ai-sdk/openai-compatible',
      env: [],
      api: 'https://local-provider.test/v1',
      doc: 'https://example.test/docs',
      models: {'test-model': model},
    };
    const adapter = resolveModelAdapter(provider, model, {
      credentials: {},
      adapter: 'catalog',
    });
    const result = streamText({model: adapter.languageModel, prompt: 'Hi'});

    assert.equal(await result.text, 'Hello');
    assert.equal(
      receivedURL,
      'https://local-provider.test/v1/chat/completions',
    );
    assert.equal(receivedBody.model, 'test-model');
    assert.equal(receivedBody.messages[0].content, 'Hi');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
