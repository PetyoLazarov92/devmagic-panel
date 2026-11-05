import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AssistantModel } from '@devmagic-panel/shared';
import { ASSISTANT_MODELS, isAssistantModel } from '@devmagic-panel/shared';

/** Panel preferences in ~/.config/devmagic-panel/settings.json; nothing secret goes here. */
export interface PanelSettings {
  assistant: { enabled: boolean; model: AssistantModel };
}

export const DEFAULT_SETTINGS: PanelSettings = { assistant: { enabled: false, model: ASSISTANT_MODELS[0].id } };

export function readSettings(file: string): PanelSettings {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { assistant?: { enabled?: unknown; model?: unknown } };
    const model = typeof raw.assistant?.model === 'string' && isAssistantModel(raw.assistant.model) ? raw.assistant.model : DEFAULT_SETTINGS.assistant.model;
    return { assistant: { enabled: raw.assistant?.enabled === true, model } };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function writeSettings(file: string, settings: PanelSettings): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}
