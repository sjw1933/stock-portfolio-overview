import type { AiApiConfig } from '../types';

const aiConfigKey = 'gup-ai-api-config-v1';

export const defaultAiConfig: AiApiConfig = {
  provider: 'openai',
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.5',
};

export function readAiConfig(): AiApiConfig {
  try {
    const value = JSON.parse(localStorage.getItem(aiConfigKey) || 'null') as Partial<AiApiConfig> | null;
    if (!value) return defaultAiConfig;
    return sanitizeAiConfig(value);
  } catch {
    return defaultAiConfig;
  }
}

export function saveAiConfig(config: AiApiConfig) {
  localStorage.setItem(aiConfigKey, JSON.stringify(sanitizeAiConfig(config)));
}

export function clearAiConfig() {
  localStorage.removeItem(aiConfigKey);
}

export function sanitizeAiConfig(config: Partial<AiApiConfig>): AiApiConfig {
  const provider = config.provider === 'anthropic' ? 'anthropic' : 'openai';
  return {
    provider,
    apiKey: String(config.apiKey || '').trim(),
    baseUrl: String(config.baseUrl || (provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')).trim(),
    model: String(config.model || (provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-5.5')).trim(),
  };
}

export function aiConfigPayload(config: AiApiConfig) {
  return config.apiKey.trim() ? { aiConfig: sanitizeAiConfig(config) } : {};
}
