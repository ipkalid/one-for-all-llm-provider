import {mkdir, readFile, rename, stat, unlink, writeFile} from 'fs/promises';
import * as path from 'path';
import secureJsonParse from 'secure-json-parse';

export const MODELS_DEV_API_URL = 'https://models.dev/api.json';
const CACHE_FILENAME = 'models-dev-api.json';
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;

export interface ModelsDevReasoningOption {
  type: 'toggle' | 'effort' | 'budget_tokens' | string;
  values?: string[];
  min?: number;
  max?: number;
}

export interface ModelsDevModelProviderOverride {
  npm?: string;
  api?: string;
  shape?: string;
}

export interface ModelsDevModel {
  id: string;
  name: string;
  description: string;
  family?: string;
  attachment: boolean;
  reasoning: boolean;
  reasoning_options: ModelsDevReasoningOption[];
  tool_call: boolean;
  structured_output?: boolean;
  temperature?: boolean;
  knowledge?: string;
  release_date: string;
  last_updated: string;
  modalities: {
    input: string[];
    output: string[];
  };
  limit: {
    context: number;
    input?: number;
    output: number;
  };
  cost?: Record<string, unknown>;
  status?: string;
  experimental?: boolean;
  interleaved?: boolean | {field?: string};
  provider?: ModelsDevModelProviderOverride;
}

export interface ModelsDevProvider {
  id: string;
  name: string;
  npm: string;
  env: string[];
  api?: string;
  doc: string;
  models: Record<string, ModelsDevModel>;
}

export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

export interface CatalogSnapshot {
  catalog: ModelsDevCatalog;
  source: 'network' | 'cache';
  loadedAt: Date;
}

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function normalizeReasoningOptions(value: unknown): ModelsDevReasoningOption[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap(item => {
    if (!isRecord(item) || typeof item.type !== 'string') {
      return [];
    }
    return [
      {
        type: item.type,
        values: stringArray(item.values),
        min: optionalNumber(item.min),
        max: optionalNumber(item.max),
      },
    ];
  });
}

function normalizeProviderOverride(
  value: unknown,
): ModelsDevModelProviderOverride | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    npm: typeof value.npm === 'string' ? value.npm : undefined,
    api: typeof value.api === 'string' ? value.api : undefined,
    shape: typeof value.shape === 'string' ? value.shape : undefined,
  };
}

function normalizeModel(
  id: string,
  value: unknown,
): ModelsDevModel | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const limit = isRecord(value.limit) ? value.limit : {};
  const modalities = isRecord(value.modalities) ? value.modalities : {};
  const modelId = typeof value.id === 'string' ? value.id : id;
  if (!modelId) {
    return undefined;
  }

  return {
    id: modelId,
    name: typeof value.name === 'string' ? value.name : modelId,
    description:
      typeof value.description === 'string' ? value.description : modelId,
    family: typeof value.family === 'string' ? value.family : undefined,
    attachment: value.attachment === true,
    reasoning: value.reasoning === true,
    reasoning_options: normalizeReasoningOptions(value.reasoning_options),
    tool_call: value.tool_call === true,
    structured_output:
      typeof value.structured_output === 'boolean'
        ? value.structured_output
        : undefined,
    temperature:
      typeof value.temperature === 'boolean' ? value.temperature : undefined,
    knowledge:
      typeof value.knowledge === 'string' ? value.knowledge : undefined,
    release_date:
      typeof value.release_date === 'string' ? value.release_date : 'unknown',
    last_updated:
      typeof value.last_updated === 'string' ? value.last_updated : 'unknown',
    modalities: {
      input: stringArray(modalities.input),
      output: stringArray(modalities.output),
    },
    limit: {
      context: positiveNumber(limit.context, 1),
      input: optionalNumber(limit.input),
      output: positiveNumber(limit.output, 1),
    },
    cost: isRecord(value.cost) ? value.cost : undefined,
    status: typeof value.status === 'string' ? value.status : undefined,
    experimental:
      typeof value.experimental === 'boolean' ? value.experimental : undefined,
    interleaved:
      typeof value.interleaved === 'boolean' || isRecord(value.interleaved)
        ? value.interleaved
        : undefined,
    provider: normalizeProviderOverride(value.provider),
  };
}

function normalizeProvider(
  id: string,
  value: unknown,
): ModelsDevProvider | undefined {
  if (!isRecord(value) || !isRecord(value.models)) {
    return undefined;
  }

  const providerId = typeof value.id === 'string' ? value.id : id;
  const models = Object.fromEntries(
    Object.entries(value.models).flatMap(([modelId, model]) => {
      const normalized = normalizeModel(modelId, model);
      return normalized ? [[normalized.id, normalized]] : [];
    }),
  );

  if (!providerId || Object.keys(models).length === 0) {
    return undefined;
  }

  return {
    id: providerId,
    name: typeof value.name === 'string' ? value.name : providerId,
    npm:
      typeof value.npm === 'string' ? value.npm : '@ai-sdk/openai-compatible',
    env: stringArray(value.env),
    api: typeof value.api === 'string' ? value.api : undefined,
    doc: typeof value.doc === 'string' ? value.doc : MODELS_DEV_API_URL,
    models,
  };
}

export function parseModelsDevCatalog(value: unknown): ModelsDevCatalog {
  if (!isRecord(value)) {
    throw new Error('models.dev returned a non-object catalog.');
  }

  const catalog = Object.fromEntries(
    Object.entries(value).flatMap(([providerId, provider]) => {
      const normalized = normalizeProvider(providerId, provider);
      return normalized ? [[normalized.id, normalized]] : [];
    }),
  );

  if (Object.keys(catalog).length === 0) {
    throw new Error('models.dev returned an empty provider catalog.');
  }

  return catalog;
}

export class ModelsDevCatalogService {
  private snapshot?: CatalogSnapshot;
  private loading?: Promise<CatalogSnapshot>;

  constructor(
    private readonly storageDirectory: string,
    private readonly url = MODELS_DEV_API_URL,
    private readonly cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    private readonly fetcher: Fetcher = globalThis.fetch,
  ) {}

  async getCatalog(forceRefresh = false): Promise<CatalogSnapshot> {
    if (this.snapshot && !forceRefresh) {
      return this.snapshot;
    }
    if (this.loading && !forceRefresh) {
      return this.loading;
    }

    this.loading = this.load(forceRefresh);
    try {
      this.snapshot = await this.loading;
      return this.snapshot;
    } finally {
      this.loading = undefined;
    }
  }

  async clearCache(): Promise<void> {
    this.snapshot = undefined;
    try {
      await unlink(this.cachePath);
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  private get cachePath(): string {
    return path.join(this.storageDirectory, CACHE_FILENAME);
  }

  private async load(forceRefresh: boolean): Promise<CatalogSnapshot> {
    const cached = await this.readCache();
    if (cached && !forceRefresh && cached.fresh) {
      return cached.snapshot;
    }

    try {
      return await this.fetchCatalog();
    } catch (error) {
      if (cached) {
        return cached.snapshot;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to load the models.dev catalog: ${message}`);
    }
  }

  private async readCache(): Promise<
    {snapshot: CatalogSnapshot; fresh: boolean} | undefined
  > {
    try {
      const [contents, metadata] = await Promise.all([
        readFile(this.cachePath, 'utf8'),
        stat(this.cachePath),
      ]);
      const parsed = secureJsonParse.parse(contents);
      return {
        snapshot: {
          catalog: parseModelsDevCatalog(parsed),
          source: 'cache',
          loadedAt: metadata.mtime,
        },
        fresh: Date.now() - metadata.mtimeMs < this.cacheTtlMs,
      };
    } catch {
      return undefined;
    }
  }

  private async fetchCatalog(): Promise<CatalogSnapshot> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetcher(this.url, {
        headers: {accept: 'application/json'},
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const text = await response.text();
      const catalog = parseModelsDevCatalog(secureJsonParse.parse(text));
      await this.writeCache(text);
      return {catalog, source: 'network', loadedAt: new Date()};
    } finally {
      clearTimeout(timeout);
    }
  }

  private async writeCache(contents: string): Promise<void> {
    await mkdir(this.storageDirectory, {recursive: true});
    const temporary = `${this.cachePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, contents, 'utf8');
    await rename(temporary, this.cachePath);
  }
}
