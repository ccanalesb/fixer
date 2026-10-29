export type KnownProviderPreset = {
  id: string;
  label: string;
  baseUrl: string;
  authMode: 'none' | 'bearer';
  extraHeaders?: Record<string, string>;
};

export const KNOWN_PROVIDER_PRESETS: KnownProviderPreset[] = [
  { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', authMode: 'none' },
  { id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', authMode: 'none' },
  { id: 'vllm', label: 'vLLM', baseUrl: 'http://localhost:8000/v1', authMode: 'none' },
  { id: 'llamacpp', label: 'llama.cpp', baseUrl: 'http://localhost:8080/v1', authMode: 'none' },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    authMode: 'bearer',
    extraHeaders: { 'HTTP-Referer': 'fixer', 'X-Title': 'Fixer' },
  },
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', authMode: 'bearer' },
  {
    id: 'nvidia-nim',
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    authMode: 'bearer',
  },
];
