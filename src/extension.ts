import * as vscode from 'vscode';
import {canResolveProvider} from './adapters';
import {
  MODELS_DEV_API_URL,
  ModelsDevCatalogService,
  type ModelsDevProvider,
} from './catalog';
import {
  ProviderStore,
  type AdapterOverride,
  type ProviderConnection,
} from './provider-store';
import {OneForAllLlmProvider, type UsageCallback} from './provider';

const EXTENSION_ID = 'one-for-all-llm-provider';

function catalogConfiguration(): {
  url: string;
  cacheTtlMs: number;
} {
  const configuration = vscode.workspace.getConfiguration(EXTENSION_ID);
  const url = configuration.get<string>('catalogUrl', MODELS_DEV_API_URL);
  const cacheHours = configuration.get<number>('catalogCacheHours', 24);
  return {
    url,
    cacheTtlMs: Math.max(1, cacheHours) * 60 * 60 * 1000,
  };
}

async function loadCatalog(
  service: ModelsDevCatalogService,
  forceRefresh = false,
) {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: forceRefresh
        ? 'Refreshing models.dev catalog'
        : 'Loading models.dev catalog',
      cancellable: false,
    },
    () => service.getCatalog(forceRefresh),
  );
}

async function pickProvider(
  service: ModelsDevCatalogService,
  providerIds?: readonly string[],
): Promise<ModelsDevProvider | undefined> {
  const {catalog} = await loadCatalog(service);
  const allowed = providerIds ? new Set(providerIds) : undefined;
  const providers = Object.values(catalog)
    .filter(provider => !allowed || allowed.has(provider.id))
    .sort((left, right) => left.name.localeCompare(right.name));

  const selected = await vscode.window.showQuickPick(
    providers.map(provider => ({
      label: provider.name,
      description: `${Object.keys(provider.models).length} models`,
      detail: `${provider.id} · ${provider.npm}${canResolveProvider(provider) ? '' : ' · custom endpoint required'}`,
      provider,
    })),
    {
      title: 'One for All LLM Provider',
      placeHolder: 'Choose a provider from models.dev',
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  return selected?.provider;
}

function isSecretEnvironmentName(name: string): boolean {
  return /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name);
}

function credentialFields(provider: ModelsDevProvider): Array<{
  key: string;
  label: string;
}> {
  const endpointEnvironment = [
    provider.api,
    ...Object.values(provider.models).map(model => model.provider?.api),
  ].flatMap(value =>
    value
      ? [...value.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map(match => match[1])
      : [],
  );
  const environmentNames = [
    ...new Set([...provider.env, ...endpointEnvironment]),
  ];
  if (
    provider.env.length > 1 &&
    provider.env.every(name => /API.?KEY|APIKEY|TOKEN/i.test(name))
  ) {
    return [
      {key: provider.env[0], label: provider.env.join(' or ')},
      ...environmentNames
        .filter(name => !provider.env.includes(name))
        .map(key => ({key, label: key})),
    ];
  }
  return environmentNames.map(key => ({key, label: key}));
}

async function promptCredentials(
  provider: ModelsDevProvider,
  existing: ProviderConnection | undefined,
): Promise<Record<string, string> | undefined> {
  const credentials = {...(existing?.credentials ?? {})};
  for (const field of credentialFields(provider)) {
    const stored = credentials[field.key];
    const environmentValue = process.env[field.key];
    const input = await vscode.window.showInputBox({
      title: `Configure ${provider.name}`,
      prompt: `${field.label}${stored ? ' (leave blank to keep the stored value)' : environmentValue ? ' (already available from the environment)' : ' (optional if your environment supplies it)'}`,
      placeHolder: isSecretEnvironmentName(field.key)
        ? 'Enter credential or leave blank'
        : `Enter ${field.key} or leave blank`,
      password: isSecretEnvironmentName(field.key),
      ignoreFocusOut: true,
    });
    if (input === undefined) {
      return undefined;
    }
    const trimmed = input.trim();
    if (trimmed) {
      credentials[field.key] = trimmed;
    }
  }
  return credentials;
}

async function promptAdapter(
  provider: ModelsDevProvider,
  current: AdapterOverride | undefined,
): Promise<AdapterOverride | undefined> {
  const values: Array<{
    label: string;
    description: string;
    value: AdapterOverride;
  }> = [
    {
      label: 'Catalog adapter',
      description: `Use ${provider.npm} from models.dev`,
      value: 'catalog',
    },
    {
      label: 'OpenAI-compatible',
      description: 'Use a /chat/completions-compatible endpoint',
      value: 'openai-compatible',
    },
    {
      label: 'Anthropic-compatible',
      description: 'Use an Anthropic Messages-compatible endpoint',
      value: 'anthropic',
    },
  ];
  const selected = await vscode.window.showQuickPick(
    values.map(item => ({
      ...item,
      picked: item.value === (current ?? 'catalog'),
    })),
    {
      title: `Adapter for ${provider.name}`,
      placeHolder: 'Choose the API protocol',
    },
  );
  return selected?.value;
}

async function selectModelsForProvider(
  provider: ModelsDevProvider,
  store: ProviderStore,
): Promise<boolean> {
  const currentlyEnabled = store.getEnabledModelIds(provider.id);
  const selected = await vscode.window.showQuickPick(
    Object.values(provider.models)
      .filter(model => model.status !== 'deprecated')
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(model => ({
        label: model.name,
        description: model.id,
        detail: [
          model.reasoning ? 'reasoning' : undefined,
          model.tool_call ? 'tools' : undefined,
          model.modalities.input.includes('image') ? 'images' : undefined,
          `${model.limit.context.toLocaleString()} context`,
        ]
          .filter(Boolean)
          .join(' · '),
        picked: currentlyEnabled ? currentlyEnabled.includes(model.id) : true,
        modelId: model.id,
      })),
    {
      title: `${provider.name} models`,
      placeHolder: 'Select the models to expose in VS Code',
      canPickMany: true,
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  if (!selected) {
    return false;
  }
  await store.setEnabledModelIds(
    provider.id,
    selected.map(item => item.modelId),
  );
  return true;
}

async function configureProvider(
  service: ModelsDevCatalogService,
  store: ProviderStore,
  languageProvider: OneForAllLlmProvider,
): Promise<void> {
  const provider = await pickProvider(service);
  if (!provider) {
    return;
  }
  const existing = await store.getConnection(provider.id);
  const credentials = await promptCredentials(provider, existing);
  if (!credentials) {
    return;
  }
  const adapter = await promptAdapter(provider, existing?.adapter);
  if (!adapter) {
    return;
  }
  const defaultURL = existing?.baseURL ?? provider.api ?? '';
  const baseURL = await vscode.window.showInputBox({
    title: `Endpoint for ${provider.name}`,
    prompt:
      'Leave blank to use the adapter default. You can override catalog endpoints for proxies and local servers.',
    value: defaultURL,
    placeHolder: 'https://api.example.com/v1',
    ignoreFocusOut: true,
    validateInput: value => {
      if (!value.trim()) {
        return adapter !== 'catalog' && !provider.api
          ? 'Enter the compatible API base URL for this adapter override.'
          : undefined;
      }
      try {
        new URL(value.replace(/\$\{[A-Z0-9_]+\}/g, 'placeholder'));
        return undefined;
      } catch {
        return 'Enter an absolute HTTP(S) URL or leave it blank.';
      }
    },
  });
  if (baseURL === undefined) {
    return;
  }

  await store.saveConnection(provider.id, {
    credentials,
    adapter,
    baseURL: baseURL.trim() || undefined,
  });
  await selectModelsForProvider(provider, store);
  languageProvider.fireLanguageModelChatInformationChange();
  vscode.window.showInformationMessage(
    `${provider.name} is now available in the VS Code model picker.`,
  );
}

async function selectProviderModels(
  service: ModelsDevCatalogService,
  store: ProviderStore,
  languageProvider: OneForAllLlmProvider,
): Promise<void> {
  const provider = await pickProvider(
    service,
    store.getConfiguredProviderIds(),
  );
  if (!provider) {
    return;
  }
  if (await selectModelsForProvider(provider, store)) {
    languageProvider.fireLanguageModelChatInformationChange();
  }
}

async function removeProvider(
  service: ModelsDevCatalogService,
  store: ProviderStore,
  languageProvider: OneForAllLlmProvider,
): Promise<void> {
  const provider = await pickProvider(
    service,
    store.getConfiguredProviderIds(),
  );
  if (!provider) {
    return;
  }
  const confirmation = await vscode.window.showWarningMessage(
    `Remove ${provider.name} and its stored credentials?`,
    {modal: true},
    'Remove',
  );
  if (confirmation !== 'Remove') {
    return;
  }
  await store.removeProvider(provider.id);
  languageProvider.fireLanguageModelChatInformationChange();
}

async function refreshCatalog(
  service: ModelsDevCatalogService,
  languageProvider: OneForAllLlmProvider,
): Promise<void> {
  const snapshot = await loadCatalog(service, true);
  languageProvider.fireLanguageModelChatInformationChange();
  const providerCount = Object.keys(snapshot.catalog).length;
  const modelCount = Object.values(snapshot.catalog).reduce(
    (total, provider) => total + Object.keys(provider.models).length,
    0,
  );
  vscode.window.showInformationMessage(
    `Loaded ${providerCount} providers and ${modelCount.toLocaleString()} models from models.dev.`,
  );
}

async function manageProviders(
  service: ModelsDevCatalogService,
  store: ProviderStore,
  languageProvider: OneForAllLlmProvider,
): Promise<void> {
  const configured = store.getConfiguredProviderIds().length;
  const selected = await vscode.window.showQuickPick(
    [
      {
        label: '$(add) Add or reconfigure a provider',
        description: 'Choose from models.dev and store credentials securely',
        action: 'configure',
      },
      {
        label: '$(list-selection) Select provider models',
        description: 'Choose which catalog models appear in VS Code',
        action: 'models',
      },
      {
        label: '$(trash) Remove a provider',
        description: 'Delete a provider and its stored credentials',
        action: 'remove',
      },
      {
        label: '$(refresh) Refresh models.dev catalog',
        description: 'Download the latest providers, models, and capabilities',
        action: 'refresh',
      },
    ],
    {
      title: `One for All LLM Provider · ${configured} configured`,
      placeHolder: 'Manage providers and models',
    },
  );
  switch (selected?.action) {
    case 'configure':
      await configureProvider(service, store, languageProvider);
      break;
    case 'models':
      await selectProviderModels(service, store, languageProvider);
      break;
    case 'remove':
      await removeProvider(service, store, languageProvider);
      break;
    case 'refresh':
      await refreshCatalog(service, languageProvider);
      break;
    default:
      break;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const {url, cacheTtlMs} = catalogConfiguration();
  const catalogService = new ModelsDevCatalogService(
    context.globalStorageUri.fsPath,
    url,
    cacheTtlMs,
  );
  const providerStore = new ProviderStore(context.secrets, context.globalState);

  let requestCount = 0;
  let totalTokens = 0;
  let lastUsage: Parameters<UsageCallback>[0] | undefined;
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  status.command = `${EXTENSION_ID}.manage`;
  const updateStatus = () => {
    const providerCount = providerStore.getConfiguredProviderIds().length;
    status.text = `$(globe) LLM Global: ${providerCount} · ${requestCount} req`;
    status.tooltip = [
      `${providerCount} configured providers`,
      `${requestCount} requests this session`,
      `${totalTokens.toLocaleString()} total tokens`,
      lastUsage
        ? `${lastUsage.cachedInputTokens.toLocaleString()} cached input tokens on the last request`
        : undefined,
      'Click to manage providers',
    ]
      .filter((item): item is string => Boolean(item))
      .join('\n');
  };
  updateStatus();
  status.show();

  const onUsage: UsageCallback = usage => {
    requestCount += 1;
    totalTokens += usage.totalTokens;
    lastUsage = usage;
    updateStatus();
  };

  const languageProvider = new OneForAllLlmProvider(
    catalogService,
    providerStore,
    onUsage,
  );

  context.subscriptions.push(
    status,
    vscode.lm.registerLanguageModelChatProvider(EXTENSION_ID, languageProvider),
    vscode.commands.registerCommand(`${EXTENSION_ID}.manage`, async () => {
      await manageProviders(catalogService, providerStore, languageProvider);
      updateStatus();
    }),
    vscode.commands.registerCommand(
      `${EXTENSION_ID}.configureProvider`,
      async () => {
        await configureProvider(
          catalogService,
          providerStore,
          languageProvider,
        );
        updateStatus();
      },
    ),
    vscode.commands.registerCommand(
      `${EXTENSION_ID}.selectModels`,
      async () => {
        await selectProviderModels(
          catalogService,
          providerStore,
          languageProvider,
        );
        updateStatus();
      },
    ),
    vscode.commands.registerCommand(
      `${EXTENSION_ID}.removeProvider`,
      async () => {
        await removeProvider(catalogService, providerStore, languageProvider);
        updateStatus();
      },
    ),
    vscode.commands.registerCommand(
      `${EXTENSION_ID}.refreshCatalog`,
      async () => {
        await refreshCatalog(catalogService, languageProvider);
        updateStatus();
      },
    ),
  );

  void catalogService.getCatalog().catch(() => {
    // Discovery will surface a detailed error when the user opens provider UI.
  });
}

export function deactivate(): void {}
