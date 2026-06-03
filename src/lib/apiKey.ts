const STORAGE_KEY = 'anthropic-api-key';

export function getApiKey(): string | null {
  return localStorage.getItem(STORAGE_KEY) || null;
}

export function setApiKey(key: string): void {
  localStorage.setItem(STORAGE_KEY, key.trim());
}

export function clearApiKey(): void {
  localStorage.removeItem(STORAGE_KEY);
}
