// src/platform/keychain.ts
import keytar from 'keytar';

/**
 * OS keychain service name. Must match the Tauri bundle identifier
 * (`com.benjamin.desktopwork`) so that all DesktopWork components share the same keychain namespace.
 */
const SERVICE = 'com.benjamin.desktopwork';

/**
 * Read the API key from OS keychain.
 * @param account - The keychain account name (e.g. 'anthropic')
 * @returns The stored password, or null if not set
 */
export async function getApiKey(account: string): Promise<string | null> {
  return await keytar.getPassword(SERVICE, account);
}

/**
 * Write the API key to OS keychain.
 */
export async function setApiKey(account: string, key: string): Promise<void> {
  await keytar.setPassword(SERVICE, account, key);
}

/**
 * Delete the API key from OS keychain.
 */
export async function deleteApiKey(account: string): Promise<boolean> {
  return await keytar.deletePassword(SERVICE, account);
}

/**
 * Resolve the keychain account name from a `keytar:<account>` reference.
 * If the ref is missing or malformed, defaults to 'anthropic'.
 */
export function resolveAccount(apiKeyRef: string | undefined): string {
  if (!apiKeyRef) return 'anthropic';
  const prefix = 'keytar:';
  return apiKeyRef.startsWith(prefix) ? apiKeyRef.slice(prefix.length) : apiKeyRef;
}