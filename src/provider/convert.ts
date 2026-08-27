import * as vscode from 'vscode';
import {
  jsonSchema,
  tool,
  type AssistantModelMessage,
  type FilePart,
  type ModelMessage,
  type TextPart,
  type ToolCallPart,
  type ToolModelMessage,
  type ToolSet,
  type UserModelMessage,
} from 'ai';
import {readThinkingText} from './thinking';

function textPart(value: string): TextPart {
  return {type: 'text', text: value};
}

function filePart(value: vscode.LanguageModelDataPart): FilePart {
  return {
    type: 'file',
    data: value.data,
    mediaType: value.mimeType,
  };
}

function toolResultText(value: vscode.LanguageModelToolResultPart): string {
  return value.content
    .map(part => {
      if (part instanceof vscode.LanguageModelTextPart) {
        return part.value;
      }
      if (
        part instanceof vscode.LanguageModelDataPart &&
        part.mimeType.startsWith('text/')
      ) {
        return new TextDecoder().decode(part.data);
      }
      return '';
    })
    .join('');
}

function collectToolNames(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelToolCallPart) {
        names.set(part.callId, part.name);
      }
    }
  }
  return names;
}

function assistantMessage(
  message: vscode.LanguageModelChatRequestMessage,
): AssistantModelMessage {
  const content: AssistantModelMessage['content'] = [];
  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      content.push(textPart(part.value));
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      const call: ToolCallPart = {
        type: 'tool-call',
        toolCallId: part.callId,
        toolName: part.name,
        input: part.input,
      };
      content.push(call);
    } else {
      const reasoning = readThinkingText(part);
      if (reasoning) {
        content.push({type: 'reasoning', text: reasoning});
      }
    }
  }
  return {role: 'assistant', content};
}

function userMessages(
  message: vscode.LanguageModelChatRequestMessage,
  toolNames: Map<string, string>,
): ModelMessage[] {
  const userContent: UserModelMessage['content'] = [];
  const toolContent: ToolModelMessage['content'] = [];

  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      userContent.push(textPart(part.value));
    } else if (part instanceof vscode.LanguageModelDataPart) {
      userContent.push(filePart(part));
    } else if (part instanceof vscode.LanguageModelToolResultPart) {
      toolContent.push({
        type: 'tool-result',
        toolCallId: part.callId,
        toolName: toolNames.get(part.callId) ?? 'tool',
        output: {type: 'text', value: toolResultText(part)},
      });
    }
  }

  const result: ModelMessage[] = [];
  if (toolContent.length > 0) {
    result.push({role: 'tool', content: toolContent});
  }
  if (userContent.length > 0) {
    result.push({role: 'user', content: userContent});
  }
  return result;
}

export function convertMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): ModelMessage[] {
  const toolNames = collectToolNames(messages);
  return messages.flatMap(message =>
    message.role === vscode.LanguageModelChatMessageRole.Assistant
      ? [assistantMessage(message)]
      : userMessages(message, toolNames),
  );
}

export function convertTools(
  tools?: readonly vscode.LanguageModelChatTool[],
): ToolSet | undefined {
  if (!tools?.length) {
    return undefined;
  }

  return Object.fromEntries(
    tools.map(item => [
      item.name,
      tool({
        description: item.description,
        inputSchema: jsonSchema(item.inputSchema ?? {}),
      }),
    ]),
  );
}
