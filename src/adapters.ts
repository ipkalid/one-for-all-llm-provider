import type {LanguageModel} from 'ai';
import {createAmazonBedrock} from '@ai-sdk/amazon-bedrock';
import {createAnthropic} from '@ai-sdk/anthropic';
import {createAzure} from '@ai-sdk/azure';
import {createCerebras} from '@ai-sdk/cerebras';
import {createCohere} from '@ai-sdk/cohere';
import {createDeepInfra} from '@ai-sdk/deepinfra';
import {createGateway} from '@ai-sdk/gateway';
import {createGoogle} from '@ai-sdk/google';
import {createGoogleVertex} from '@ai-sdk/google-vertex';
import {createGoogleVertexAnthropic} from '@ai-sdk/google-vertex/anthropic';
import {createGroq} from '@ai-sdk/groq';
import {createMistral} from '@ai-sdk/mistral';
import {createOpenAI} from '@ai-sdk/openai';
import {createOpenAICompatible} from '@ai-sdk/openai-compatible';
import {createPerplexity} from '@ai-sdk/perplexity';
import {createTogetherAI} from '@ai-sdk/togetherai';
import {createVercel} from '@ai-sdk/vercel';
import {createXai} from '@ai-sdk/xai';
import {createOpenRouter} from '@openrouter/ai-sdk-provider';
import {createSaladCloud} from '@saladtechnologies-oss/ai-sdk-provider';
import {createAiGateway} from 'ai-gateway-provider';
import type {
  ModelsDevModel,
  ModelsDevProvider,
  ModelsDevModelProviderOverride,
} from './catalog';
import type {ProviderConnection} from './provider-store';

const SUPPORTED_PACKAGES = new Set([
  '@ai-sdk/amazon-bedrock',
  '@ai-sdk/anthropic',
  '@ai-sdk/azure',
  '@ai-sdk/cerebras',
  '@ai-sdk/cohere',
  '@ai-sdk/deepinfra',
  '@ai-sdk/gateway',
  '@ai-sdk/google',
  '@ai-sdk/google-vertex',
  '@ai-sdk/google-vertex/anthropic',
  '@ai-sdk/groq',
  '@ai-sdk/mistral',
  '@ai-sdk/openai',
  '@ai-sdk/openai-compatible',
  '@ai-sdk/perplexity',
  '@ai-sdk/togetherai',
  '@ai-sdk/vercel',
  '@ai-sdk/xai',
  '@aihubmix/ai-sdk-provider',
  '@openrouter/ai-sdk-provider',
  '@qvac/ai-sdk-provider',
  '@saladtechnologies-oss/ai-sdk-provider',
  'ai-gateway-provider',
  'venice-ai-sdk-provider',
]);

const QVAC_DEFAULT_BASE_URL = 'http://127.0.0.1:11435/v1';
const AIHUBMIX_DEFAULT_BASE_URL = 'https://aihubmix.com';
const VENICE_DEFAULT_BASE_URL = 'https://api.venice.ai/api/v1';

export interface ResolvedAdapter {
  languageModel: LanguageModel;
  packageName: string;
  providerOptionsKey: string;
}

function mergeEnvironment(
  connection: ProviderConnection,
): Record<string, string | undefined> {
  return {...process.env, ...connection.credentials};
}

function findApiKey(
  provider: ModelsDevProvider,
  environment: Record<string, string | undefined>,
): string | undefined {
  const candidates = [
    ...provider.env.filter(name => /API.?KEY|APIKEY|TOKEN/i.test(name)),
    ...provider.env,
  ];
  for (const name of candidates) {
    const value = environment[name]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function interpolateEnvironment(
  value: string | undefined,
  environment: Record<string, string | undefined>,
): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
    const replacement = environment[name];
    if (!replacement) {
      throw new Error(
        `The endpoint requires ${name}. Configure it for this provider first.`,
      );
    }
    return replacement;
  });
}

function catalogPackage(
  provider: ModelsDevProvider,
  model: ModelsDevModel,
  connection: ProviderConnection,
): string {
  if (connection.adapter === 'openai-compatible') {
    return '@ai-sdk/openai-compatible';
  }
  if (connection.adapter === 'anthropic') {
    return '@ai-sdk/anthropic';
  }
  return model.provider?.npm ?? provider.npm;
}

function endpointFor(
  provider: ModelsDevProvider,
  override: ModelsDevModelProviderOverride | undefined,
  connection: ProviderConnection,
  environment: Record<string, string | undefined>,
): string | undefined {
  return interpolateEnvironment(
    connection.baseURL ?? override?.api ?? provider.api,
    environment,
  );
}

function googleAuthOptions(
  environment: Record<string, string | undefined>,
): {keyFilename?: string} | undefined {
  const keyFilename = environment.GOOGLE_APPLICATION_CREDENTIALS;
  return keyFilename ? {keyFilename} : undefined;
}

function openAIModel(
  provider: ReturnType<typeof createOpenAI>,
  model: ModelsDevModel,
): LanguageModel {
  if (model.provider?.shape === 'completions') {
    return provider.chat(model.id);
  }
  if (model.provider?.shape === 'responses') {
    return provider.responses(model.id);
  }
  return provider.languageModel(model.id);
}

function withPath(baseURL: string, path: string): string {
  const root = baseURL.replace(/\/$/, '');
  return root.endsWith(path) ? root : `${root}${path}`;
}

export function canResolveProvider(provider: ModelsDevProvider): boolean {
  return SUPPORTED_PACKAGES.has(provider.npm) || Boolean(provider.api);
}

export function resolveModelAdapter(
  provider: ModelsDevProvider,
  model: ModelsDevModel,
  connection: ProviderConnection,
): ResolvedAdapter {
  const environment = mergeEnvironment(connection);
  const apiKey = findApiKey(provider, environment);
  const packageName = catalogPackage(provider, model, connection);
  const baseURL = endpointFor(
    provider,
    model.provider,
    connection,
    environment,
  );

  if (
    connection.adapter === 'catalog' &&
    provider.npm === 'ai-gateway-provider'
  ) {
    const accountId = environment.CLOUDFLARE_ACCOUNT_ID;
    const gateway = environment.CLOUDFLARE_GATEWAY_ID;
    if (!accountId || !gateway) {
      throw new Error(
        `${provider.name} requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_GATEWAY_ID.`,
      );
    }
    const cloudflare = createAiGateway({accountId, gateway, apiKey});
    const unified = createOpenAICompatible({
      name: 'cloudflare-unified',
      baseURL: 'https://gateway.ai.cloudflare.com/v1/compat',
    });
    return {
      languageModel: cloudflare(unified.languageModel(model.id)),
      packageName: provider.npm,
      providerOptionsKey: 'cloudflare-ai-gateway',
    };
  }

  if (model.provider?.shape === 'responses') {
    if (!baseURL) {
      throw new Error(
        `${provider.name} needs a Responses API base URL for ${model.name}.`,
      );
    }
    const responses = createOpenAI({apiKey, baseURL, name: provider.id});
    return {
      languageModel: responses.responses(model.id),
      packageName: '@ai-sdk/openai',
      providerOptionsKey: provider.id,
    };
  }

  switch (packageName) {
    case '@ai-sdk/openai-compatible': {
      if (!baseURL) {
        throw new Error(
          `${provider.name} needs an OpenAI-compatible base URL. Reconfigure the provider and enter one.`,
        );
      }
      const compatible = createOpenAICompatible({
        name: provider.id,
        baseURL,
        apiKey,
        includeUsage: true,
        supportsStructuredOutputs: model.structured_output,
      });
      return {
        languageModel: compatible.languageModel(model.id),
        packageName,
        providerOptionsKey: provider.id,
      };
    }
    case '@ai-sdk/openai': {
      const openai = createOpenAI({
        apiKey,
        baseURL,
        name: provider.id,
      });
      return {
        languageModel: openAIModel(openai, model),
        packageName,
        providerOptionsKey: provider.id,
      };
    }
    case '@ai-sdk/anthropic': {
      if (
        connection.adapter === 'anthropic' &&
        provider.npm !== '@ai-sdk/anthropic' &&
        !baseURL
      ) {
        throw new Error(
          `${provider.name} needs an Anthropic-compatible base URL. Reconfigure the provider and enter one.`,
        );
      }
      const anthropic = createAnthropic({apiKey, baseURL, name: provider.id});
      return {
        languageModel: anthropic.languageModel(model.id),
        packageName,
        providerOptionsKey: 'anthropic',
      };
    }
    case '@ai-sdk/google': {
      const google = createGoogle({apiKey, baseURL, name: provider.id});
      return {
        languageModel: google.languageModel(model.id),
        packageName,
        providerOptionsKey: 'google',
      };
    }
    case '@ai-sdk/amazon-bedrock': {
      const bedrock = createAmazonBedrock({
        apiKey: environment.AWS_BEARER_TOKEN_BEDROCK,
        accessKeyId: environment.AWS_ACCESS_KEY_ID,
        secretAccessKey: environment.AWS_SECRET_ACCESS_KEY,
        sessionToken: environment.AWS_SESSION_TOKEN,
        region: environment.AWS_REGION,
        baseURL,
      });
      return {
        languageModel: bedrock.languageModel(model.id),
        packageName,
        providerOptionsKey: 'bedrock',
      };
    }
    case '@ai-sdk/azure': {
      const azure = createAzure({
        apiKey,
        baseURL,
        resourceName:
          environment.AZURE_RESOURCE_NAME ??
          environment.AZURE_COGNITIVE_SERVICES_RESOURCE_NAME,
      });
      return {
        languageModel: azure.languageModel(model.id),
        packageName,
        providerOptionsKey: 'azure',
      };
    }
    case '@ai-sdk/cohere': {
      const cohere = createCohere({apiKey, baseURL});
      return {
        languageModel: cohere.languageModel(model.id),
        packageName,
        providerOptionsKey: 'cohere',
      };
    }
    case '@ai-sdk/cerebras': {
      const cerebras = createCerebras({apiKey, baseURL});
      return {
        languageModel: cerebras.languageModel(model.id),
        packageName,
        providerOptionsKey: 'cerebras',
      };
    }
    case '@ai-sdk/deepinfra': {
      const deepInfra = createDeepInfra({apiKey, baseURL});
      return {
        languageModel: deepInfra.languageModel(model.id),
        packageName,
        providerOptionsKey: 'deepinfra',
      };
    }
    case '@ai-sdk/gateway': {
      const gateway = createGateway({apiKey, baseURL});
      return {
        languageModel: gateway.languageModel(model.id),
        packageName,
        providerOptionsKey: 'gateway',
      };
    }
    case '@ai-sdk/google-vertex': {
      const vertex = createGoogleVertex({
        apiKey: environment.GOOGLE_VERTEX_API_KEY,
        project: environment.GOOGLE_VERTEX_PROJECT,
        location: environment.GOOGLE_VERTEX_LOCATION,
        baseURL,
        googleAuthOptions: googleAuthOptions(environment),
      });
      return {
        languageModel: vertex.languageModel(model.id),
        packageName,
        providerOptionsKey: 'vertex',
      };
    }
    case '@ai-sdk/google-vertex/anthropic': {
      const vertexAnthropic = createGoogleVertexAnthropic({
        project: environment.GOOGLE_VERTEX_PROJECT,
        location: environment.GOOGLE_VERTEX_LOCATION,
        baseURL,
        googleAuthOptions: googleAuthOptions(environment),
      });
      return {
        languageModel: vertexAnthropic.languageModel(model.id),
        packageName,
        providerOptionsKey: 'vertex',
      };
    }
    case '@ai-sdk/groq': {
      const groq = createGroq({apiKey, baseURL});
      return {
        languageModel: groq.languageModel(model.id),
        packageName,
        providerOptionsKey: 'groq',
      };
    }
    case '@ai-sdk/mistral': {
      const mistral = createMistral({apiKey, baseURL});
      return {
        languageModel: mistral.languageModel(model.id),
        packageName,
        providerOptionsKey: 'mistral',
      };
    }
    case '@ai-sdk/perplexity': {
      const perplexity = createPerplexity({apiKey, baseURL});
      return {
        languageModel: perplexity.languageModel(model.id),
        packageName,
        providerOptionsKey: 'perplexity',
      };
    }
    case '@ai-sdk/togetherai': {
      const together = createTogetherAI({apiKey, baseURL});
      return {
        languageModel: together.languageModel(model.id),
        packageName,
        providerOptionsKey: 'togetherai',
      };
    }
    case '@ai-sdk/xai': {
      const xai = createXai({apiKey, baseURL});
      return {
        languageModel: xai.languageModel(model.id),
        packageName,
        providerOptionsKey: 'xai',
      };
    }
    case '@ai-sdk/vercel': {
      const vercel = createVercel({apiKey, baseURL});
      return {
        languageModel: vercel.languageModel(model.id),
        packageName,
        providerOptionsKey: 'vercel',
      };
    }
    case '@openrouter/ai-sdk-provider': {
      const openrouter = createOpenRouter({
        apiKey,
        baseURL,
        compatibility: 'strict',
        appName: 'One for All LLM Provider for VS Code',
      });
      return {
        languageModel: openrouter.languageModel(model.id),
        packageName,
        providerOptionsKey: 'openrouter',
      };
    }
    case '@qvac/ai-sdk-provider': {
      const qvac = createOpenAICompatible({
        name: provider.id,
        baseURL: baseURL ?? QVAC_DEFAULT_BASE_URL,
        apiKey: apiKey ?? 'qvac',
        includeUsage: true,
        supportsStructuredOutputs: model.structured_output,
      });
      return {
        languageModel: qvac.languageModel(model.id),
        packageName,
        providerOptionsKey: provider.id,
      };
    }
    case '@saladtechnologies-oss/ai-sdk-provider': {
      const salad = createSaladCloud({apiKey, baseURL});
      return {
        languageModel: salad.languageModel(model.id),
        packageName,
        providerOptionsKey: 'salad-cloud',
      };
    }
    case '@aihubmix/ai-sdk-provider': {
      const root = baseURL ?? AIHUBMIX_DEFAULT_BASE_URL;
      const headers = {'APP-Code': 'WHVL9885'};
      if (model.id.startsWith('claude-')) {
        const anthropic = createAnthropic({
          apiKey,
          baseURL: withPath(root, '/v1'),
          headers,
          name: provider.id,
        });
        return {
          languageModel: anthropic.languageModel(model.id),
          packageName: '@ai-sdk/anthropic',
          providerOptionsKey: 'anthropic',
        };
      }
      if (
        (model.id.startsWith('gemini') || model.id.startsWith('imagen')) &&
        !model.id.endsWith('-nothink') &&
        !model.id.endsWith('-search')
      ) {
        const google = createGoogle({
          apiKey,
          baseURL: withPath(root, '/gemini/v1beta'),
          headers,
          name: provider.id,
        });
        return {
          languageModel: google.languageModel(model.id),
          packageName: '@ai-sdk/google',
          providerOptionsKey: 'google',
        };
      }
      const compatible = createOpenAICompatible({
        name: provider.id,
        baseURL: withPath(root, '/v1'),
        apiKey,
        headers,
        includeUsage: true,
        supportsStructuredOutputs: model.structured_output,
      });
      return {
        languageModel: compatible.languageModel(model.id),
        packageName: '@ai-sdk/openai-compatible',
        providerOptionsKey: provider.id,
      };
    }
    case 'venice-ai-sdk-provider': {
      const venice = createOpenAICompatible({
        name: provider.id,
        baseURL: baseURL ?? VENICE_DEFAULT_BASE_URL,
        apiKey,
        includeUsage: true,
        supportsStructuredOutputs: model.structured_output,
      });
      return {
        languageModel: venice.languageModel(model.id),
        packageName: '@ai-sdk/openai-compatible',
        providerOptionsKey: 'venice',
      };
    }
    default: {
      if (baseURL) {
        const compatible = createOpenAICompatible({
          name: provider.id,
          baseURL,
          apiKey,
          includeUsage: true,
          supportsStructuredOutputs: model.structured_output,
        });
        return {
          languageModel: compatible.languageModel(model.id),
          packageName: '@ai-sdk/openai-compatible',
          providerOptionsKey: provider.id,
        };
      }
      throw new Error(
        `${provider.name} uses unsupported adapter ${packageName}. Reconfigure it with an OpenAI-compatible or Anthropic endpoint override.`,
      );
    }
  }
}
