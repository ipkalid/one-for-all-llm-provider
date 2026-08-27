# One for All LLM Provider

Version 1.0.0

[Install from the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=KhalidAlhazmi.one-for-all-llm-provider)

Use models from the live [models.dev](https://models.dev) catalog in VS Code chat and agents with your own provider credentials.

The extension downloads and caches the catalog instead of hard-coding a model list. Add the providers you use, choose which of their models should appear, and then select those models from VS Code's normal model picker.

## Features

- Loads providers, models, capabilities, limits, and reasoning settings from `https://models.dev/api.json`
- Stores each provider's credentials in VS Code Secret Storage
- Supports provider-specific endpoints, environment variables, proxies, and local OpenAI-compatible servers
- Maps image input, tool calling, context/output limits, reasoning controls, temperature, and model metadata to the VS Code Language Model API
- Streams text, reasoning, tool calls, tool results, images, cancellation, and usage through a common adapter layer
- Keeps the last valid catalog on disk so configured models remain available during a models.dev outage

## Setup

1. Open the Command Palette and run **One for All LLM Provider: Add or Configure Provider**.
2. Choose a provider from the models.dev catalog.
3. Enter the credential and endpoint fields shown for that provider. Blank credential fields fall back to the extension host's environment variables.
4. Select the models you want to expose in VS Code.
5. Open VS Code Chat and select a model under **One for All LLM Provider**.

Use **One for All LLM Provider: Manage Providers** later to add, reconfigure, filter, remove, or refresh providers.

## Catalog mapping

| models.dev field | VS Code behavior |
|---|---|
| Provider `id`, `name`, `npm`, `api`, `env` | Provider picker, protocol adapter, endpoint, and credential prompts |
| Model `id`, `name`, `family`, dates | Stable global ID, picker name, family, version, and provider detail |
| `limit.context`, `limit.input`, `limit.output` | Input and output token limits |
| `modalities.input` and `attachment` | Image/file input support |
| `tool_call` | Tool-calling capability |
| `reasoning` and `reasoning_options` | Per-model effort, toggle, or token-budget controls |
| `temperature` | Per-model temperature presets |
| Model-level `provider` overrides | Alternate API protocol, endpoint, and Responses API routing |

models.dev catalogs providers and models; it does not define VS Code agents. Once this extension registers a selected model, VS Code agents that use the Language Model API can use it normally.

## Provider coverage

The adapter layer supports the large OpenAI-compatible portion of the catalog plus native adapters for OpenAI, Anthropic, Google, Amazon Bedrock, Azure, Cohere, Cerebras, DeepInfra, Google Vertex, Groq, Mistral, Perplexity, Together AI, xAI, Vercel, OpenRouter, Cloudflare AI Gateway, SaladCloud, AIHubMix, Venice, and QVAC.

At the catalog snapshot used for development, 200 of 203 providers and 7,276 of 7,352 models route automatically. The catalog itself remains dynamic, so these counts will change. SAP AI Core, watsonx, and GitLab Duo currently publish community adapters for older, incompatible AI SDK protocol versions; their catalog models can still be used by choosing an OpenAI-compatible or Anthropic-compatible adapter and supplying a compatible proxy endpoint.

Unknown future catalog packages also work through one of those protocol overrides when the provider exposes a compatible endpoint.

## Commands

- `One for All LLM Provider: Manage Providers`
- `One for All LLM Provider: Add or Configure Provider`
- `One for All LLM Provider: Select Provider Models`
- `One for All LLM Provider: Remove Provider`
- `One for All LLM Provider: Refresh models.dev Catalog`

## Settings

- `one-for-all-llm-provider.catalogUrl`: a models.dev-compatible catalog URL
- `one-for-all-llm-provider.catalogCacheHours`: catalog cache lifetime, from 1 to 168 hours

## Security and behavior

- Credentials entered in the UI are stored in VS Code Secret Storage, not settings or the catalog cache.
- Environment variables declared by models.dev are used as a fallback and are never copied into extension state.
- The catalog is metadata only; adding a provider does not send a request until a VS Code chat or agent invokes one of its models.
- Token counting is an estimate because the models.dev schema does not provide provider tokenizers.

## Development

```bash
npm install
npm test
npm run build
```

## License

MIT (c)
