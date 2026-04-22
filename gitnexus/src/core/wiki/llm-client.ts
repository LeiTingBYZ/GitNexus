/**
 * LLM Client for Wiki Generation
 *
 * OpenAI-compatible API client using native fetch.
 * Supports OpenAI, Azure, LiteLLM, Ollama, and any OpenAI-compatible endpoint.
 *
 * Config priority: CLI flags > env vars > defaults
 */

import {
  ProxyAgent,
  fetch as undiciFetch,
  setGlobalDispatcher,
  getGlobalDispatcher,
  Agent,
} from 'undici';

// Set global dispatcher timeout to 0 (no timeout) on module load
const globalDispatcher = getGlobalDispatcher();
if (globalDispatcher instanceof Agent) {
  // Create a new Agent with no timeout and copy connections from existing dispatcher
  const noTimeoutDispatcher = new Agent({
    bodyTimeout: 0,
    headersTimeout: 0,
  });
  setGlobalDispatcher(noTimeoutDispatcher);
}

export type LLMProvider = 'openai' | 'openrouter' | 'azure' | 'custom' | 'cursor';

/**
 * Get proxy agent from explicit URL or environment variables
 * Priority: explicit URL > http_proxy > HTTP_PROXY > https_proxy > HTTPS_PROXY
 */
function getProxyAgent(explicitProxyUrl?: string): ProxyAgent | null {
  const proxyUrl =
    explicitProxyUrl ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.HTTPS_PROXY;

  if (proxyUrl) {
    // Create ProxyAgent with no timeout limits
    return new ProxyAgent({
      uri: proxyUrl,
      bodyTimeout: 0,
      headersTimeout: 0,
    });
  }
  return null;
}

export interface LLMConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
  /** Provider type — controls auth header behaviour */
  provider?: 'openai' | 'openrouter' | 'azure' | 'custom' | 'cursor';
  /** Azure api-version query param (e.g. '2024-10-21'). Appended to URL when set. */
  apiVersion?: string;
  /** When true, strips sampling params and uses max_completion_tokens instead of max_tokens */
  isReasoningModel?: boolean;
  /** Explicit proxy URL (e.g. http://proxy:8080) */
  proxyUrl?: string;
}

export interface LLMResponse {
  content: string;
  promptTokens?: number;
  completionTokens?: number;
}

/**
 * Resolve LLM configuration from env vars, saved config, and optional overrides.
 * Priority: overrides (CLI flags) > env vars > ~/.gitnexus/config.json > error
 *
 * If no API key is found, returns config with empty apiKey (caller should handle).
 */
export async function resolveLLMConfig(overrides?: Partial<LLMConfig>): Promise<LLMConfig> {
  const { loadCLIConfig } = await import('../../storage/repo-manager.js');
  const savedConfig = await loadCLIConfig();

  const apiKey =
    overrides?.apiKey ||
    process.env.GITNEXUS_API_KEY ||
    process.env.OPENAI_API_KEY ||
    savedConfig.apiKey ||
    '';

  return {
    apiKey,
    baseUrl:
      overrides?.baseUrl ||
      process.env.GITNEXUS_LLM_BASE_URL ||
      savedConfig.baseUrl ||
      'https://openrouter.ai/api/v1',
    model:
      overrides?.model ||
      process.env.GITNEXUS_MODEL ||
      (savedConfig.provider === 'cursor' ? savedConfig.cursorModel : undefined) ||
      savedConfig.model ||
      'minimax/minimax-m2.5',
    maxTokens: overrides?.maxTokens ?? 16_384,
    temperature: overrides?.temperature ?? 0,
    provider: overrides?.provider ?? savedConfig.provider ?? 'openai',
    apiVersion:
      overrides?.apiVersion || process.env.GITNEXUS_AZURE_API_VERSION || savedConfig.apiVersion,
    isReasoningModel: overrides?.isReasoningModel ?? savedConfig.isReasoningModel,
    proxyUrl: overrides?.proxyUrl || savedConfig.proxyUrl,
  };
}

/**
 * Estimate token count from text (rough heuristic: ~4 chars per token).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Returns true if the given base URL is an Azure OpenAI endpoint.
 * Uses proper hostname matching to avoid spoofed URLs like
 * "https://myresource.openai.azure.com.evil.com/v1".
 */
export function isAzureProvider(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(baseUrl);
    return hostname.endsWith('.openai.azure.com') || hostname.endsWith('.services.ai.azure.com');
  } catch {
    // If URL is malformed, fall back to substring check
    return baseUrl.includes('.openai.azure.com') || baseUrl.includes('.services.ai.azure.com');
  }
}

/**
 * Returns true if the model name matches a known reasoning model pattern,
 * or if the explicit override is true.
 * Pass override=false to force non-reasoning even for o-series names.
 */
export function isReasoningModel(model: string, override?: boolean): boolean {
  if (override !== undefined) return override;
  // Match known bare reasoning models (o1, o3) and any o-series with -mini/-preview suffix
  return /^o[1-9]\d*(-mini|-preview)$|^o1$|^o3$/i.test(model);
}

/**
 * Build the full chat completions URL, appending ?api-version when provided.
 */
export function buildRequestUrl(baseUrl: string, apiVersion: string | undefined): string {
  const base = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return apiVersion ? `${base}?api-version=${encodeURIComponent(apiVersion)}` : base;
}

export interface CallLLMOptions {
  onChunk?: (charsReceived: number) => void;
}

/**
 * Call an OpenAI-compatible LLM API.
 * Uses streaming when onChunk callback is provided for real-time progress.
 * Retries up to 3 times on transient failures (429, 5xx, network errors).
 */
export async function callLLM(
  prompt: string,
  config: LLMConfig,
  systemPrompt?: string,
  options?: CallLLMOptions,
): Promise<LLMResponse> {
  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  // Detect Azure endpoint (by provider field or URL pattern)
  const azure = config.provider === 'azure' || isAzureProvider(config.baseUrl);

  // Warn when using Azure legacy deployment URL without api-version
  if (azure && !config.apiVersion && config.baseUrl.includes('/deployments/')) {
    console.warn(
      '[gitnexus] Warning: Azure legacy deployment URL detected but no api-version set. Add --api-version 2024-10-21 or use the v1 API format.',
    );
  }

  // Detect reasoning model (o1, o3, o4-mini etc.) or explicit override
  const reasoning = isReasoningModel(config.model, config.isReasoningModel);

  const url = buildRequestUrl(config.baseUrl, azure ? config.apiVersion : undefined);
  const useStream = !!options?.onChunk;

  // Build request body — reasoning models reject temperature and use max_completion_tokens
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
  };

  // max_tokens is deprecated; use max_completion_tokens for all models
  body.max_completion_tokens = config.maxTokens;

  // Only send temperature for non-Azure providers — some Azure models reject non-default values
  if (!reasoning && !azure && config.temperature !== undefined) {
    body.temperature = config.temperature;
  }

  if (useStream) body.stream = true;

  // Build auth headers — Azure uses api-key header, everyone else uses Authorization: Bearer
  const authHeaders: Record<string, string> = azure
    ? { 'api-key': config.apiKey }
    : { Authorization: `Bearer ${config.apiKey}` };

  const MAX_RETRIES = 3;
  let lastError: Error | null = null;
  const proxyAgent = getProxyAgent(config.proxyUrl);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await undiciFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify(body),
        dispatcher: proxyAgent ?? undefined,
        bodyTimeout: 0,
        headersTimeout: 0,
        keepAliveTimeout: 0,
      } as any);

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown error');

        // Azure content filter — surface a clear message instead of a generic API error
        if (
          azure &&
          response.status === 400 &&
          (errorText.includes('content_filter') ||
            errorText.includes('ResponsibleAIPolicyViolation'))
        ) {
          throw new Error(
            `Azure content filter blocked this request. The prompt triggered content policy. Details: ${errorText.slice(0, 300)}`,
          );
        }

        // Rate limit — wait with exponential backoff and retry
        if (response.status === 429 && attempt < MAX_RETRIES - 1) {
          const retryAfter = parseInt(response.headers.get('retry-after') || '0', 10);
          const delay = retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 3000;
          await sleep(delay);
          continue;
        }

        // Server error — retry with backoff
        if (response.status >= 500 && attempt < MAX_RETRIES - 1) {
          await sleep((attempt + 1) * 2000);
          continue;
        }

        throw new Error(`LLM API error (${response.status}): ${errorText.slice(0, 500)}`);
      }

      // Streaming path
      if (useStream && response.body) {
        return await readSSEStream(response.body, options!.onChunk!);
      }

      // Non-streaming path
      const json = (await response.json()) as any;
      const choice = json.choices?.[0];
      if (!choice?.message?.content) {
        throw new Error('LLM returned empty response');
      }

      // Clean up reasoning content from models that include <thinking> or 【】 tags
      const content = choice.message.content
        .replace(/<thinking>[\s\S]*?<\/thinking>|【 thinking 】[\s\S]*?【\/ thinking 】/gi, '')
        .trim();

      return {
        content,
        promptTokens: json.usage?.prompt_tokens,
        completionTokens: json.usage?.completion_tokens,
      };
    } catch (err: any) {
      lastError = err;
      const errMsg = err.message || String(err);
      const errCode = err.code || 'unknown';

      // Network error — retry with backoff
      const isRetryable =
        errCode === 'ECONNREFUSED' ||
        errCode === 'ETIMEDOUT' ||
        errMsg.includes('fetch') ||
        errMsg.includes('ECONNREFUSED') ||
        errMsg.includes('timeout') ||
        errMsg.includes('aborted') ||
        errMsg.includes('socket');

      if (attempt < MAX_RETRIES - 1 && isRetryable) {
        await sleep((attempt + 1) * 3000);
        continue;
      }

      // Only log on final failure
      process.stderr.write(`\n[LLM] Error: ${errMsg.slice(0, 200)}\n`);
      throw err;
    }
  }

  throw lastError || new Error('LLM call failed after retries');
}

/**
 * Read an SSE stream from an OpenAI-compatible streaming response.
 */
async function readSSEStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (charsReceived: number) => void,
): Promise<LLMResponse> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let content = '';
  let buffer = '';
  let contentFilterTriggered = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);
        const choice = parsed.choices?.[0];

        // Detect content filter finish reason — skip delta from this chunk
        if (choice?.finish_reason === 'content_filter') {
          contentFilterTriggered = true;
          continue;
        }

        const delta = choice?.delta?.content;
        if (delta) {
          content += delta;
          onChunk(content.length);
        }
      } catch {
        // Skip malformed SSE chunks
      }
    }
  }

  if (contentFilterTriggered) {
    throw new Error(
      'content filter triggered mid-stream. The generated content was blocked by content policy. Adjust your prompt and retry.',
    );
  }

  if (!content) {
    throw new Error('LLM returned empty streaming response');
  }

  // Clean up reasoning content from models that include <thinking> or 【】 tags
  content = content
    .replace(/<thinking>[\s\S]*?<\/thinking>|【 thinking 】[\s\S]*?【\/ thinking 】/gi, '')
    .trim();

  return { content };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
