import * as vscode from 'vscode';
import {streamText, type LanguageModelUsage} from 'ai';
import type {JSONObject, SharedV4ProviderOptions} from '@ai-sdk/provider';
import {resolveModelAdapter, type ResolvedAdapter} from '../adapters';
import type {ModelsDevCatalogService} from '../catalog';
import {
  globalModelId,
  resolveModelSettings,
  toModelInformation,
  type CatalogModelReference,
  type ModelConfigurationOptions,
  type ResolvedModelSettings,
} from '../models';
import type {ProviderStore} from '../provider-store';
import {convertMessages, convertTools} from './convert';
import {createThinkingPart} from './thinking';

export type UsageCallback = (usage: {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
}) => void;

function numeric(value: number | undefined): number {
  return value ?? 0;
}

function toUsage(usage: LanguageModelUsage): Parameters<UsageCallback>[0] {
  return {
    inputTokens: numeric(usage.inputTokens),
    outputTokens: numeric(usage.outputTokens),
    totalTokens: numeric(usage.totalTokens),
    cachedInputTokens: numeric(usage.inputTokenDetails.cacheReadTokens),
    reasoningTokens: numeric(usage.outputTokenDetails.reasoningTokens),
  };
}

function providerOptions(
  adapter: ResolvedAdapter,
  settings: ResolvedModelSettings,
): SharedV4ProviderOptions | undefined {
  if (!settings.reasoningBudget) {
    return undefined;
  }

  let options: JSONObject;
  switch (adapter.packageName) {
    case '@ai-sdk/anthropic':
      options = {
        thinking: {
          type: 'enabled',
          budgetTokens: settings.reasoningBudget,
        },
      };
      break;
    case '@ai-sdk/google':
      options = {
        thinkingConfig: {
          thinkingBudget: settings.reasoningBudget,
          includeThoughts: true,
        },
      };
      break;
    case '@ai-sdk/amazon-bedrock':
      options = {
        reasoningConfig: {
          type: 'enabled',
          budgetTokens: settings.reasoningBudget,
        },
      };
      break;
    case '@ai-sdk/cohere':
      options = {
        thinking: {
          type: 'enabled',
          tokenBudget: settings.reasoningBudget,
        },
      };
      break;
    default:
      return undefined;
  }

  return {[adapter.providerOptionsKey]: options};
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const candidate = error as {statusCode?: unknown; status?: unknown};
  return typeof candidate.statusCode === 'number'
    ? candidate.statusCode
    : typeof candidate.status === 'number'
      ? candidate.status
      : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class OneForAllLlmProvider implements vscode.LanguageModelChatProvider {
  private readonly _onDidChangeLanguageModelChatInformation =
    new vscode.EventEmitter<void>();
  private readonly modelIndex = new Map<string, CatalogModelReference>();

  readonly onDidChangeLanguageModelChatInformation =
    this._onDidChangeLanguageModelChatInformation.event;

  constructor(
    private readonly catalogService: ModelsDevCatalogService,
    private readonly providerStore: ProviderStore,
    private readonly onUsage?: UsageCallback,
  ) {}

  fireLanguageModelChatInformationChange(): void {
    this.modelIndex.clear();
    this._onDidChangeLanguageModelChatInformation.fire();
  }

  async refreshCatalog(): Promise<void> {
    await this.catalogService.getCatalog(true);
    this.fireLanguageModelChatInformationChange();
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    void options;
    if (token.isCancellationRequested) {
      return [];
    }

    const configured = this.providerStore.getConfiguredProviderIds();
    if (configured.length === 0) {
      return [];
    }

    const {catalog} = await this.catalogService.getCatalog();
    this.modelIndex.clear();
    const information: vscode.LanguageModelChatInformation[] = [];

    for (const providerId of configured) {
      const provider = catalog[providerId];
      if (!provider) {
        continue;
      }
      const enabled = this.providerStore.getEnabledModelIds(providerId);
      const enabledSet = enabled ? new Set(enabled) : undefined;
      for (const model of Object.values(provider.models)) {
        if (
          model.status === 'deprecated' ||
          (enabledSet && !enabledSet.has(model.id))
        ) {
          continue;
        }
        const id = globalModelId(provider.id, model.id);
        this.modelIndex.set(id, {provider, model});
        information.push(toModelInformation(provider, model));
      }
    }

    return information.sort(
      (left, right) =>
        (left.detail ?? '').localeCompare(right.detail ?? '') ||
        left.name.localeCompare(right.name),
    );
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const reference = await this.findModel(model.id);
    if (!reference) {
      throw new Error(
        `Model ${model.id} is no longer present in the models.dev catalog. Refresh the catalog and select another model.`,
      );
    }
    const connection = await this.providerStore.getConnection(
      reference.provider.id,
    );
    if (!connection) {
      throw new Error(
        `${reference.provider.name} is not configured. Use “One for All LLM Provider: Manage Providers”.`,
      );
    }

    try {
      const adapter = resolveModelAdapter(
        reference.provider,
        reference.model,
        connection,
      );
      const settings = resolveModelSettings(
        reference.model,
        options as ModelConfigurationOptions,
      );
      const tools = convertTools(options.tools);
      const result = streamText({
        model: adapter.languageModel,
        messages: convertMessages(messages),
        tools,
        toolChoice:
          tools &&
          options.toolMode === vscode.LanguageModelChatToolMode.Required
            ? 'required'
            : tools
              ? 'auto'
              : undefined,
        maxOutputTokens: settings.maxOutputTokens,
        temperature: settings.temperature,
        reasoning:
          settings.reasoning === 'provider-default'
            ? undefined
            : settings.reasoning,
        providerOptions: providerOptions(adapter, settings),
        abortSignal: this.cancellationSignal(token),
      });

      for await (const part of result.fullStream) {
        if (token.isCancellationRequested) {
          return;
        }
        switch (part.type) {
          case 'text-delta':
            progress.report(new vscode.LanguageModelTextPart(part.text));
            break;
          case 'reasoning-delta': {
            const thinking = createThinkingPart(part.text);
            if (thinking) {
              progress.report(thinking);
            }
            break;
          }
          case 'tool-call':
            progress.report(
              new vscode.LanguageModelToolCallPart(
                part.toolCallId,
                part.toolName,
                part.input,
              ),
            );
            break;
          case 'finish':
            this.onUsage?.(toUsage(part.totalUsage));
            break;
          case 'error':
            throw part.error;
          default:
            break;
        }
      }
    } catch (error) {
      if (token.isCancellationRequested) {
        return;
      }
      this.throwMappedError(error, reference.provider.name);
    }
  }

  provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken,
  ): Thenable<number> {
    void model;
    void token;
    if (typeof text === 'string') {
      return Promise.resolve(Math.ceil(Buffer.byteLength(text, 'utf8') / 4));
    }

    let bytes = 0;
    for (const part of text.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        bytes += Buffer.byteLength(part.value, 'utf8');
      } else if (part instanceof vscode.LanguageModelDataPart) {
        bytes += part.data.byteLength;
      }
    }
    return Promise.resolve(Math.ceil(bytes / 4));
  }

  private async findModel(
    id: string,
  ): Promise<CatalogModelReference | undefined> {
    const indexed = this.modelIndex.get(id);
    if (indexed) {
      return indexed;
    }

    const {catalog} = await this.catalogService.getCatalog();
    for (const provider of Object.values(catalog)) {
      for (const model of Object.values(provider.models)) {
        if (globalModelId(provider.id, model.id) === id) {
          const reference = {provider, model};
          this.modelIndex.set(id, reference);
          return reference;
        }
      }
    }
    return undefined;
  }

  private cancellationSignal(token: vscode.CancellationToken): AbortSignal {
    const controller = new AbortController();
    if (token.isCancellationRequested) {
      controller.abort();
    } else {
      token.onCancellationRequested(() => controller.abort());
    }
    return controller.signal;
  }

  private throwMappedError(error: unknown, providerName: string): never {
    const status = statusCode(error);
    if (status === 401 || status === 403) {
      throw new Error(
        `${providerName} rejected the configured credentials. Reconfigure the provider and try again.`,
      );
    }
    if (status === 429) {
      throw new Error(
        `${providerName} rate limit exceeded. Wait or choose another provider/model.`,
      );
    }
    throw new Error(`${providerName} request failed: ${errorMessage(error)}`);
  }
}
