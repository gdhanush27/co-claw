import * as assert from 'assert';
import { describe, it, afterEach } from 'mocha';
import * as vscode from 'vscode';
import { ModelManager } from '../lm/ModelManager';

/**
 * Tier-based model resolution is the critical contract of ModelManager: when
 * a tier override is set we must hand back that model; when it isn't, or when
 * the configured family isn't available, we must fall back to the default
 * model. These tests stub `vscode.workspace.getConfiguration` and
 * `vscode.lm.selectChatModels` directly because the production code reads
 * from both stores on every resolution.
 */
describe('ModelManager tier resolution', () => {
    const originalGetConfig = vscode.workspace.getConfiguration;
    const originalSelectModels = vscode.lm.selectChatModels;

    function stubConfig(values: Partial<Record<'light' | 'medium' | 'hard', string>> & { family?: string } = {}): void {
        (vscode.workspace as any).getConfiguration = (section?: string) => ({
            get: <T>(key: string, defaultValue?: T): T => {
                if (section === 'CoClaw.models' && (key === 'light' || key === 'medium' || key === 'hard')) {
                    return (values[key] as T) ?? (defaultValue as T);
                }
                if (section === 'CoClaw.model' && key === 'family') {
                    return (values.family as T) ?? (defaultValue as T);
                }
                return defaultValue as T;
            },
            update: async () => {},
        });
    }

    function stubModels(families: string[]): void {
        (vscode.lm as any).selectChatModels = async () => families.map(family => ({
            name: family.toUpperCase(),
            family,
            maxInputTokens: 128_000,
            sendRequest: async () => ({ stream: (async function* () {})() }),
        }));
    }

    function makeMemento(): vscode.Memento {
        const store = new Map<string, unknown>();
        const memento: any = {
            get: (key: string, def?: unknown) => store.has(key) ? store.get(key) : def,
            update: async (key: string, value: unknown) => { store.set(key, value); },
            keys: () => Array.from(store.keys()),
        };
        return memento as vscode.Memento;
    }

    afterEach(() => {
        (vscode.workspace as any).getConfiguration = originalGetConfig;
        (vscode.lm as any).selectChatModels = originalSelectModels;
    });

    it('getTierFamily returns the configured family for a tier', () => {
        stubConfig({ light: 'gpt-4o-mini', hard: 'claude-3.5-sonnet' });
        const mm = new ModelManager(makeMemento());
        assert.strictEqual(mm.getTierFamily('light'), 'gpt-4o-mini');
        assert.strictEqual(mm.getTierFamily('hard'), 'claude-3.5-sonnet');
        assert.strictEqual(mm.getTierFamily('medium'), undefined);
    });

    it('getTierFamily ignores blank / whitespace-only settings', () => {
        // Important: VS Code returns "" for an unset string contribution, so
        // we must NOT treat it as a configured family or every tier would
        // claim to be overridden.
        stubConfig({ light: '', medium: '   ' as any });
        const mm = new ModelManager(makeMemento());
        assert.strictEqual(mm.getTierFamily('light'), undefined);
        assert.strictEqual(mm.getTierFamily('medium'), undefined);
    });

    it('getModelForTier returns the configured tier model when available', async () => {
        stubConfig({ hard: 'claude-3.5-sonnet' });
        stubModels(['gpt-4o-mini', 'gpt-4o', 'claude-3.5-sonnet']);
        const mm = new ModelManager(makeMemento());
        const m = await mm.getModelForTier('hard');
        assert.strictEqual((m as any).family, 'claude-3.5-sonnet');
    });

    it('getModelForTier falls back to the default model when configured family is unavailable', async () => {
        // User configured a family that Copilot no longer exposes; we must
        // not throw, but we must NOT silently keep picking the wrong model
        // either — the fallback path uses getActiveModel which honors the
        // preferred family / first available model.
        stubConfig({ hard: 'phantom-model' });
        stubModels(['gpt-4o', 'gpt-4o-mini']);
        const mm = new ModelManager(makeMemento());
        const m = await mm.getModelForTier('hard');
        assert.strictEqual((m as any).family, 'gpt-4o', 'should fall back to first available model');
    });

    it('getModelForTier falls back when no override is configured', async () => {
        stubConfig({});
        stubModels(['gpt-4o', 'gpt-4o-mini']);
        const mm = new ModelManager(makeMemento());
        const m = await mm.getModelForTier('medium');
        assert.strictEqual((m as any).family, 'gpt-4o');
    });

    it('getAllTierFamilies returns the current snapshot of all three tiers', () => {
        stubConfig({ light: 'gpt-4o-mini', medium: 'gpt-4o', hard: 'claude-3.5-sonnet' });
        const mm = new ModelManager(makeMemento());
        const all = mm.getAllTierFamilies();
        assert.deepStrictEqual(all, {
            light: 'gpt-4o-mini',
            medium: 'gpt-4o',
            hard: 'claude-3.5-sonnet',
        });
    });
});
