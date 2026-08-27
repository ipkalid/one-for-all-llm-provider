import type * as vscode from 'vscode';
import type {ModelsDevModel, ModelsDevProvider} from './catalog';

export type ModelConfigurationOptions =
  vscode.ProvideLanguageModelChatResponseOptions & {
    readonly modelConfiguration?: Record<string, unknown>;
    readonly configuration?: Record<string, unknown>;
  };

export type ModelPickerChatInformation = vscode.LanguageModelChatInformation & {
  readonly isUserSelectable: boolean;
  readonly configurationSchema?: ModelConfigurationSchema;
};

export interface CatalogModelReference {
  provider: ModelsDevProvider;
  model: ModelsDevModel;
}

export interface ResolvedModelSettings {
  temperature?: number;
  maxOutputTokens?: number;
  reasoning?:
    | 'provider-default'
    | 'none'
    | 'minimal'
    | 'low'
    | 'medium'
    | 'high'
    | 'xhigh';
  reasoningBudget?: number;
  reasoningToggle?: 'enabled' | 'disabled';
}

interface ModelConfigurationProperty {
  type: 'string' | 'number';
  title: string;
  description?: string;
  default?: string | number;
  enum?: readonly string[];
  enumItemLabels?: readonly string[];
  enumDescriptions?: readonly string[];
  minimum?: number;
  maximum?: number;
  group: 'navigation';
}

export interface ModelConfigurationSchema {
  properties: Record<string, ModelConfigurationProperty>;
}

const TEMPERATURES: Record<string, number> = {
  precise: 0.2,
  balanced: 0.7,
  creative: 1,
};

function titleCase(value: string): string {
  return value
    .split(/[-_]/)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function reasoningProperties(
  model: ModelsDevModel,
): Record<string, ModelConfigurationProperty> {
  if (!model.reasoning) {
    return {};
  }

  const effortValues = unique(
    model.reasoning_options.flatMap(option =>
      option.type === 'effort' ? (option.values ?? []) : [],
    ),
  );
  if (effortValues.length > 0) {
    const values = ['provider-default', ...effortValues];
    return {
      reasoningEffort: {
        type: 'string',
        title: 'Reasoning effort',
        enum: values,
        enumItemLabels: values.map(value =>
          value === 'provider-default' ? 'Provider Default' : titleCase(value),
        ),
        enumDescriptions: values.map(value =>
          value === 'provider-default'
            ? 'Use the provider and model default'
            : `Use ${value} reasoning effort`,
        ),
        default: 'provider-default',
        group: 'navigation',
      },
    };
  }

  const budget = model.reasoning_options.find(
    option => option.type === 'budget_tokens',
  );
  if (budget) {
    const minimum = Math.max(0, budget.min ?? 0);
    const maximum = Math.max(minimum + 1, budget.max ?? model.limit.output);
    return {
      reasoningBudget: {
        type: 'number',
        title: 'Reasoning token budget',
        description: 'Zero uses the provider default or disables reasoning.',
        default: 0,
        minimum: 0,
        maximum,
        group: 'navigation',
      },
    };
  }

  const supportsToggle = model.reasoning_options.some(
    option => option.type === 'toggle',
  );
  if (supportsToggle) {
    return {
      reasoningMode: {
        type: 'string',
        title: 'Reasoning',
        enum: ['provider-default', 'enabled', 'disabled'],
        enumItemLabels: ['Provider Default', 'Enabled', 'Disabled'],
        enumDescriptions: [
          'Use the provider and model default',
          'Enable reasoning',
          'Disable reasoning',
        ],
        default: 'provider-default',
        group: 'navigation',
      },
    };
  }

  return {};
}

export function buildModelConfigurationSchema(
  model: ModelsDevModel,
): ModelConfigurationSchema {
  const properties: Record<string, ModelConfigurationProperty> = {
    ...reasoningProperties(model),
    maxOutputTokens: {
      type: 'number',
      title: 'Maximum output tokens',
      description: `Up to ${model.limit.output.toLocaleString()} tokens`,
      default: model.limit.output,
      minimum: 1,
      maximum: model.limit.output,
      group: 'navigation',
    },
  };

  if (model.temperature !== false) {
    properties.temperature = {
      type: 'string',
      title: 'Temperature',
      enum: ['provider-default', 'precise', 'balanced', 'creative'],
      enumItemLabels: [
        'Provider Default',
        'Precise (0.2)',
        'Balanced (0.7)',
        'Creative (1.0)',
      ],
      enumDescriptions: [
        'Let the provider choose',
        'More deterministic output',
        'Balanced output',
        'More varied output',
      ],
      default: 'provider-default',
      group: 'navigation',
    };
  }

  return {properties};
}

function modelTooltip(
  provider: ModelsDevProvider,
  model: ModelsDevModel,
): string {
  const capabilities = [
    model.reasoning ? 'reasoning' : undefined,
    model.tool_call ? 'tools' : undefined,
    model.modalities.input.includes('image') ? 'images' : undefined,
  ].filter((item): item is string => Boolean(item));
  const suffix = capabilities.length
    ? ` Supports ${capabilities.join(', ')}.`
    : '';
  return `${model.description} Provider: ${provider.name}.${suffix}`;
}

export function globalModelId(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

export function toModelInformation(
  provider: ModelsDevProvider,
  model: ModelsDevModel,
): ModelPickerChatInformation {
  return {
    id: globalModelId(provider.id, model.id),
    name: model.name,
    family: model.family ?? model.id.split(/[/:]/).at(-1) ?? model.id,
    version:
      model.last_updated !== 'unknown'
        ? model.last_updated
        : model.release_date,
    detail: provider.name,
    tooltip: modelTooltip(provider, model),
    maxInputTokens: Math.max(1, model.limit.input ?? model.limit.context),
    maxOutputTokens: Math.max(1, model.limit.output),
    isUserSelectable: true,
    capabilities: {
      toolCalling: model.tool_call,
      imageInput: model.modalities.input.includes('image'),
    },
    configurationSchema: buildModelConfigurationSchema(model),
  };
}

function configurationFrom(
  options: ModelConfigurationOptions,
): Record<string, unknown> {
  return options.modelConfiguration ?? options.configuration ?? {};
}

function boundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : undefined;
}

function normalizeReasoningEffort(
  value: unknown,
): ResolvedModelSettings['reasoning'] {
  if (value === 'max') {
    return 'xhigh';
  }
  return value === 'provider-default' ||
    value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
    ? value
    : undefined;
}

export function resolveModelSettings(
  model: ModelsDevModel,
  options: ModelConfigurationOptions,
): ResolvedModelSettings {
  const configuration = configurationFrom(options);
  const temperature =
    typeof configuration.temperature === 'string'
      ? TEMPERATURES[configuration.temperature]
      : undefined;
  const modelOptionMax = boundedNumber(
    options.modelOptions?.maxTokens,
    1,
    model.limit.output,
  );
  const configuredMax = boundedNumber(
    configuration.maxOutputTokens,
    1,
    model.limit.output,
  );
  const reasoning = normalizeReasoningEffort(configuration.reasoningEffort);
  const reasoningMode = configuration.reasoningMode;
  const reasoningBudget = boundedNumber(
    configuration.reasoningBudget,
    0,
    model.limit.output,
  );

  return {
    temperature,
    maxOutputTokens: modelOptionMax ?? configuredMax,
    reasoning:
      reasoning ??
      (reasoningMode === 'disabled'
        ? 'none'
        : reasoningMode === 'enabled'
          ? 'high'
          : undefined),
    reasoningBudget:
      reasoningBudget && reasoningBudget > 0 ? reasoningBudget : undefined,
    reasoningToggle:
      reasoningMode === 'enabled' || reasoningMode === 'disabled'
        ? reasoningMode
        : undefined,
  };
}
