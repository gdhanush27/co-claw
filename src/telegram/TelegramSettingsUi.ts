import * as vscode from 'vscode';
import { TelegramInlineKeyboard, TelegramInlineButton } from './TelegramCronUi';

export type SettingType = 'boolean' | 'number' | 'string' | 'enum';

export interface SettingDefinition {
    key: string;            // Full setting key e.g. "CoClaw.agents.mode"
    label: string;          // Short human label
    description: string;
    type: SettingType;
    enumValues?: string[];
    min?: number;
    max?: number;
    step?: number;
    /** Logical group for the root menu. */
    group: string;
}

/**
 * Curated list of CoClaw settings exposed via the Telegram /settings UI.
 * Mirrors the contributions in package.json.
 */
export const SETTINGS: SettingDefinition[] = [
    // Agents
    { key: 'CoClaw.agents.mode', label: 'Mode', description: 'Multi-agent orchestration mode', type: 'enum', enumValues: ['off', 'slash', 'always'], group: 'Agents' },
    { key: 'CoClaw.agents.maxParallelCoders', label: 'Max parallel coders', description: 'Max parallel Coder agents per task', type: 'number', min: 1, max: 8, step: 1, group: 'Agents' },

    // Memory
    { key: 'CoClaw.memory.autoExtract', label: 'Auto-extract', description: 'Auto-extract facts from responses', type: 'boolean', group: 'Memory' },
    { key: 'CoClaw.memory.maxLongTermEntries', label: 'Max long-term entries', description: 'Max long-term memory entries', type: 'number', min: 10, max: 1000, step: 10, group: 'Memory' },
    { key: 'CoClaw.memory.dailyLogsRetentionDays', label: 'Daily log retention (days)', description: 'How many days to keep daily logs', type: 'number', min: 1, max: 365, step: 1, group: 'Memory' },
    { key: 'CoClaw.memory.tokenBudgetPercent', label: 'Token budget %', description: 'Max % of context for memory injection', type: 'number', min: 5, max: 80, step: 5, group: 'Memory' },
    { key: 'CoClaw.memory.autoDistillThreshold', label: 'Auto-distill threshold', description: 'Daily entries before auto-distill (0 = off)', type: 'number', min: 0, max: 200, step: 5, group: 'Memory' },
    { key: 'CoClaw.memory.autoDistillIntervalHours', label: 'Auto-distill interval (h)', description: 'Hours between scheduled distills (0 = off)', type: 'number', min: 0, max: 168, step: 1, group: 'Memory' },
    { key: 'CoClaw.memory.staleAfterDays', label: 'Stale after (days)', description: 'Days before unused entries are downranked', type: 'number', min: 0, max: 365, step: 1, group: 'Memory' },

    // Heartbeat
    { key: 'CoClaw.heartbeat.enabled', label: 'Heartbeat enabled', description: 'Enable periodic heartbeat in /open mode', type: 'boolean', group: 'Heartbeat' },
    { key: 'CoClaw.heartbeat.intervalMinutes', label: 'Interval (min)', description: 'Minutes between heartbeats', type: 'number', min: 5, max: 1440, step: 5, group: 'Heartbeat' },
    { key: 'CoClaw.heartbeat.activeHoursStart', label: 'Active start (HH:MM)', description: 'Start of heartbeat active hours', type: 'string', group: 'Heartbeat' },
    { key: 'CoClaw.heartbeat.activeHoursEnd', label: 'Active end (HH:MM)', description: 'End of heartbeat active hours', type: 'string', group: 'Heartbeat' },

    // Telegram
    { key: 'CoClaw.telegram.tone', label: 'Tone', description: 'Conversational tone in /open mode', type: 'enum', enumValues: ['sarcastic', 'friendly', 'professional', 'playful', 'neutral'], group: 'Telegram' },
    { key: 'CoClaw.telegram.useEmojis', label: 'Use emojis', description: 'Allow emojis in replies and reactions', type: 'boolean', group: 'Telegram' },
    { key: 'CoClaw.telegram.sarcasticReactions', label: 'Sarcastic reactions', description: 'React with a sarcastic emoji to each /open message', type: 'boolean', group: 'Telegram' },

    // Model
    { key: 'CoClaw.model.family', label: 'Model family', description: 'Preferred Copilot model family (blank = default)', type: 'string', group: 'Model' },
];

/** Group name -> settings */
function groupedSettings(): Map<string, SettingDefinition[]> {
    const out = new Map<string, SettingDefinition[]>();
    for (const s of SETTINGS) {
        const list = out.get(s.group) ?? [];
        list.push(s);
        out.set(s.group, list);
    }
    return out;
}

function readValue(key: string): unknown {
    // Split into section + remaining path. VS Code's getConfiguration uses
    // dotted sections; safest: take everything before the last segment as
    // section, last segment as the field.
    const lastDot = key.lastIndexOf('.');
    const section = key.substring(0, lastDot);
    const field = key.substring(lastDot + 1);
    return vscode.workspace.getConfiguration(section).get(field);
}

export async function writeValue(key: string, value: unknown): Promise<void> {
    const lastDot = key.lastIndexOf('.');
    const section = key.substring(0, lastDot);
    const field = key.substring(lastDot + 1);
    await vscode.workspace.getConfiguration(section).update(field, value, vscode.ConfigurationTarget.Global);
}

export function getSetting(key: string): SettingDefinition | undefined {
    return SETTINGS.find(s => s.key === key);
}

function formatValue(s: SettingDefinition, value: unknown): string {
    if (value === undefined || value === null || value === '') { return '<i>(unset)</i>'; }
    if (s.type === 'boolean') { return value ? 'on' : 'off'; }
    return String(value);
}

/** Build the root settings menu (groups). */
export function buildSettingsRootPanel(): { text: string; buttons: TelegramInlineKeyboard } {
    const groups = groupedSettings();
    const lines: string[] = ['⚙️ <b>CoClaw Settings</b>', '', 'Pick a category to edit:'];
    const buttons: TelegramInlineKeyboard = [];
    for (const group of groups.keys()) {
        buttons.push([{ text: `📂 ${group}`, callback_data: `settings_ui:group:${group}` }]);
    }
    buttons.push([{ text: '🔄 Refresh', callback_data: 'settings_ui:root' }, { text: '✖ Close', callback_data: 'settings_ui:close' }]);
    return { text: lines.join('\n'), buttons };
}

/** Build a panel listing settings inside a group, with current values. */
export function buildSettingsGroupPanel(group: string): { text: string; buttons: TelegramInlineKeyboard } {
    const items = SETTINGS.filter(s => s.group === group);
    const lines: string[] = [`⚙️ <b>${escapeHtml(group)} settings</b>`, ''];
    const buttons: TelegramInlineKeyboard = [];
    for (const s of items) {
        const current = formatValue(s, readValue(s.key));
        lines.push(`• <b>${escapeHtml(s.label)}</b>: ${current}`);
        buttons.push([{ text: `✏️ ${s.label}`, callback_data: `settings_ui:edit:${s.key}` }]);
    }
    buttons.push([
        { text: '↩ Back', callback_data: 'settings_ui:root' },
        { text: '✖ Close', callback_data: 'settings_ui:close' },
    ]);
    return { text: lines.join('\n'), buttons };
}

/** Build a panel for editing a single setting. */
export function buildSettingEditPanel(key: string): { text: string; buttons: TelegramInlineKeyboard } | undefined {
    const s = getSetting(key);
    if (!s) { return undefined; }

    const current = formatValue(s, readValue(s.key));
    const lines: string[] = [
        `✏️ <b>${escapeHtml(s.label)}</b>`,
        `<i>${escapeHtml(s.description)}</i>`,
        '',
        `Current: <b>${current}</b>`,
        '',
    ];

    const buttons: TelegramInlineKeyboard = [];

    if (s.type === 'boolean') {
        lines.push('Tap to toggle:');
        buttons.push([
            { text: '✅ on',  callback_data: `settings_ui:set:${s.key}:true` },
            { text: '⛔ off', callback_data: `settings_ui:set:${s.key}:false` },
        ]);
    } else if (s.type === 'enum' && s.enumValues) {
        lines.push('Pick a value:');
        const row: TelegramInlineButton[] = [];
        for (const v of s.enumValues) {
            row.push({ text: v, callback_data: `settings_ui:set:${s.key}:${v}` });
            if (row.length === 3) { buttons.push(row.splice(0)); }
        }
        if (row.length > 0) { buttons.push(row); }
    } else if (s.type === 'number') {
        const step = s.step ?? 1;
        const cur = Number(readValue(s.key) ?? 0);
        lines.push(`Step: ${step}. Use buttons or send a number.`);
        buttons.push([
            { text: `−${step}`, callback_data: `settings_ui:nudge:${s.key}:${-step}` },
            { text: `+${step}`, callback_data: `settings_ui:nudge:${s.key}:${step}` },
            { text: '⌨ Type', callback_data: `settings_ui:input:${s.key}` },
        ]);
        if (s.min !== undefined) {
            buttons.push([
                { text: `Min (${s.min})`, callback_data: `settings_ui:set:${s.key}:${s.min}` },
                { text: `Max (${s.max ?? cur})`, callback_data: `settings_ui:set:${s.key}:${s.max ?? cur}` },
            ]);
        }
    } else {
        // string
        buttons.push([
            { text: '⌨ Type a value', callback_data: `settings_ui:input:${s.key}` },
            { text: '🗑 Clear', callback_data: `settings_ui:set:${s.key}:` },
        ]);
    }

    buttons.push([
        { text: '↩ Back', callback_data: `settings_ui:group:${s.group}` },
        { text: '✖ Close', callback_data: 'settings_ui:close' },
    ]);

    return { text: lines.join('\n'), buttons };
}

/** Coerce a raw string to the setting's type. Returns undefined if invalid. */
export function coerceValue(s: SettingDefinition, raw: string): unknown {
    switch (s.type) {
        case 'boolean':
            if (raw === 'true' || raw === 'on' || raw === '1') { return true; }
            if (raw === 'false' || raw === 'off' || raw === '0') { return false; }
            return undefined;
        case 'number': {
            const n = Number(raw);
            if (!Number.isFinite(n)) { return undefined; }
            if (s.min !== undefined && n < s.min) { return s.min; }
            if (s.max !== undefined && n > s.max) { return s.max; }
            return n;
        }
        case 'enum':
            return s.enumValues?.includes(raw) ? raw : undefined;
        case 'string':
            return raw;
    }
}

/** Read current value (exported for nudge handler in TelegramBot). */
export function readSettingValue(key: string): unknown {
    return readValue(key);
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
