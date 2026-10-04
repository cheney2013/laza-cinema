// Empty unless the machine configures a local OpenAI-compatible server (LM Studio, Ollama,
// vLLM...): prompt translation and optimisation are off without one.
export const DEFAULT_LLM_BASE_URL = process.env.LLM_BASE_URL?.trim().replace(/\/$/, '') || '';

export const LLM_NOT_CONFIGURED =
  '没有配置本地 LLM：在 .env 里设置 LLM_BASE_URL（例如 LM Studio 的 http://127.0.0.1:1234/v1），或在设置里填入接口地址。';

export const DEFAULT_LLM_MODEL =
  process.env.LLM_MODEL?.trim() || 'qwen2.5-vl-3b-instruct';

// OpenAI-compatible local servers commonly ignore the token but still expect
// an Authorization header. Keep NVIDIA's key as a backwards-compatible fallback.
export function resolveLlmApiKey(customApiKey?: string): string {
  return customApiKey?.trim() || process.env.LLM_API_KEY?.trim() || process.env.NV_API_KEY?.trim() || 'local';
}

export function resolveLlmBaseUrl(customBaseUrl?: string): string {
  return (customBaseUrl?.trim() || DEFAULT_LLM_BASE_URL).replace(/\/$/, '');
}
