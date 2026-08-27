import * as vscode from 'vscode';

/**
 * Create a LanguageModelThinkingPart if the VS Code version supports the proposed API.
 * Returns undefined if LanguageModelThinkingPart is not available at runtime.
 */
export function createThinkingPart(
  value: string,
): vscode.LanguageModelResponsePart | undefined {
  const ThinkingPartCtor = (
    vscode as typeof vscode & {
      LanguageModelThinkingPart?: new (
        value: string,
        id?: string,
        metadata?: {readonly [key: string]: unknown},
      ) => vscode.LanguageModelResponsePart;
    }
  ).LanguageModelThinkingPart;

  if (typeof ThinkingPartCtor !== 'function') {
    return undefined;
  }

  return new ThinkingPartCtor(value);
}

/**
 * Extract thinking content from a message part that may be a LanguageModelThinkingPart.
 * This checks for the `thinking` property which is the proposed API shape.
 */
export function readThinkingText(part: unknown): string | undefined {
  if (!part || typeof part !== 'object') {
    return undefined;
  }
  const candidate = part as {thinking?: unknown; value?: unknown};
  if (typeof candidate.thinking === 'string') {
    return candidate.thinking;
  }
  if (typeof candidate.value === 'string') {
    return candidate.value;
  }
  return undefined;
}
