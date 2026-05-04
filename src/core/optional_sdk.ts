/**
 * Helper for loading provider SDKs that are listed under
 * `optionalDependencies` in package.json.
 *
 * Each provider's SDK (`@anthropic-ai/claude-agent-sdk`,
 * `@github/copilot-sdk`, `@openai/codex-sdk`) is optional so that bots can be
 * installed with only the SDK they actually use. The relevant SDK is loaded
 * lazily via dynamic `import()` and a clear error is thrown when the package
 * is not installed.
 */

function isModuleNotFoundError(err: unknown, moduleName: string): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return true;
  const message = (err as Error).message ?? '';
  return message.includes(moduleName) && message.toLowerCase().includes('not found');
}

export async function loadOptionalSdk<T>(moduleName: string, installHint?: string): Promise<T> {
  try {
    return (await import(moduleName)) as T;
  } catch (err) {
    if (isModuleNotFoundError(err, moduleName)) {
      const hint = installHint ?? `npm install ${moduleName}`;
      throw new Error(
        `Optional dependency "${moduleName}" is not installed. ` +
        `This SDK is required for the selected provider. Install it with: ${hint}`,
      );
    }
    throw err;
  }
}
