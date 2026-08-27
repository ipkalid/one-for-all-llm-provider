const assert = require('node:assert/strict');
const {mkdtemp, rm} = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ModelsDevCatalogService,
  parseModelsDevCatalog,
} = require('../out/catalog.js');
const {resolveModelSettings, toModelInformation} = require('../out/models.js');

const fixture = {
  example: {
    id: 'example',
    name: 'Example AI',
    npm: '@ai-sdk/openai-compatible',
    env: ['EXAMPLE_API_KEY'],
    api: 'https://example.test/v1',
    doc: 'https://example.test/docs',
    models: {
      'vision-reasoner': {
        id: 'vision-reasoner',
        name: 'Vision Reasoner',
        description: 'A test model',
        family: 'reasoner',
        attachment: true,
        reasoning: true,
        reasoning_options: [{type: 'effort', values: ['low', 'high', 'max']}],
        tool_call: true,
        structured_output: true,
        temperature: true,
        release_date: '2026-01-01',
        last_updated: '2026-02-01',
        modalities: {input: ['text', 'image'], output: ['text']},
        limit: {context: 200000, input: 180000, output: 20000},
        open_weights: false,
      },
    },
  },
};

test('normalizes models.dev metadata and maps it to VS Code model information', () => {
  const catalog = parseModelsDevCatalog(fixture);
  const provider = catalog.example;
  const model = provider.models['vision-reasoner'];
  const information = toModelInformation(provider, model);

  assert.equal(information.id, 'example:vision-reasoner');
  assert.equal(information.detail, 'Example AI');
  assert.equal(information.maxInputTokens, 180000);
  assert.equal(information.maxOutputTokens, 20000);
  assert.equal(information.capabilities.imageInput, true);
  assert.equal(information.capabilities.toolCalling, true);
  assert.deepEqual(
    information.configurationSchema.properties.reasoningEffort.enum,
    ['provider-default', 'low', 'high', 'max'],
  );
});

test('maps per-model VS Code settings to portable AI SDK settings', () => {
  const catalog = parseModelsDevCatalog(fixture);
  const model = catalog.example.models['vision-reasoner'];
  const settings = resolveModelSettings(model, {
    toolMode: 1,
    modelOptions: {maxTokens: 50000},
    modelConfiguration: {
      temperature: 'precise',
      reasoningEffort: 'max',
      maxOutputTokens: 10000,
    },
  });

  assert.equal(settings.temperature, 0.2);
  assert.equal(settings.reasoning, 'xhigh');
  assert.equal(settings.maxOutputTokens, 20000);
});

test('downloads the catalog once and reuses its on-disk cache', async t => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'llm-global-catalog-'),
  );
  t.after(() => rm(directory, {recursive: true, force: true}));
  let requests = 0;
  const fetcher = async () => {
    requests += 1;
    return new Response(JSON.stringify(fixture), {
      status: 200,
      headers: {'content-type': 'application/json'},
    });
  };

  const first = new ModelsDevCatalogService(
    directory,
    'https://models.dev/api.json',
    60000,
    fetcher,
  );
  assert.equal((await first.getCatalog()).source, 'network');

  const second = new ModelsDevCatalogService(
    directory,
    'https://models.dev/api.json',
    60000,
    fetcher,
  );
  assert.equal((await second.getCatalog()).source, 'cache');
  assert.equal(requests, 1);
});
