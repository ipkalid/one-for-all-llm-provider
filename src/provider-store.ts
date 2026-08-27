import type * as vscode from 'vscode';
import secureJsonParse from 'secure-json-parse';

const CONFIGURED_PROVIDERS_KEY =
  'one-for-all-llm-provider.configuredProviderIds';
const ENABLED_MODELS_KEY_PREFIX = 'one-for-all-llm-provider.enabledModels.';
const CONNECTION_SECRET_PREFIX = 'one-for-all-llm-provider.connection.';

export type AdapterOverride = 'catalog' | 'openai-compatible' | 'anthropic';

export interface ProviderConnection {
  credentials: Record<string, string>;
  baseURL?: string;
  adapter?: AdapterOverride;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export class ProviderStore {
  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly state: vscode.Memento,
  ) {}

  getConfiguredProviderIds(): string[] {
    return unique(this.state.get<string[]>(CONFIGURED_PROVIDERS_KEY, []));
  }

  isConfigured(providerId: string): boolean {
    return this.getConfiguredProviderIds().includes(providerId);
  }

  async getConnection(
    providerId: string,
  ): Promise<ProviderConnection | undefined> {
    const raw = await this.secrets.get(this.connectionKey(providerId));
    if (!raw) {
      return undefined;
    }

    try {
      const parsed = secureJsonParse.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return undefined;
      }
      const value = parsed as Partial<ProviderConnection>;
      return {
        credentials:
          value.credentials && typeof value.credentials === 'object'
            ? Object.fromEntries(
                Object.entries(value.credentials).filter(
                  (entry): entry is [string, string] =>
                    typeof entry[1] === 'string' && entry[1].length > 0,
                ),
              )
            : {},
        baseURL:
          typeof value.baseURL === 'string' && value.baseURL.length > 0
            ? value.baseURL
            : undefined,
        adapter:
          value.adapter === 'catalog' ||
          value.adapter === 'openai-compatible' ||
          value.adapter === 'anthropic'
            ? value.adapter
            : 'catalog',
      };
    } catch {
      return undefined;
    }
  }

  async saveConnection(
    providerId: string,
    connection: ProviderConnection,
  ): Promise<void> {
    await this.secrets.store(
      this.connectionKey(providerId),
      JSON.stringify(connection),
    );
    const configured = unique([...this.getConfiguredProviderIds(), providerId]);
    await this.state.update(CONFIGURED_PROVIDERS_KEY, configured);
  }

  async removeProvider(providerId: string): Promise<void> {
    await Promise.all([
      this.secrets.delete(this.connectionKey(providerId)),
      this.state.update(this.enabledModelsKey(providerId), undefined),
      this.state.update(
        CONFIGURED_PROVIDERS_KEY,
        this.getConfiguredProviderIds().filter(id => id !== providerId),
      ),
    ]);
  }

  getEnabledModelIds(providerId: string): string[] | undefined {
    const value = this.state.get<unknown>(this.enabledModelsKey(providerId));
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : undefined;
  }

  async setEnabledModelIds(
    providerId: string,
    modelIds: readonly string[] | undefined,
  ): Promise<void> {
    await this.state.update(
      this.enabledModelsKey(providerId),
      modelIds === undefined ? undefined : unique(modelIds),
    );
  }

  private connectionKey(providerId: string): string {
    return `${CONNECTION_SECRET_PREFIX}${providerId}`;
  }

  private enabledModelsKey(providerId: string): string {
    return `${ENABLED_MODELS_KEY_PREFIX}${providerId}`;
  }
}
