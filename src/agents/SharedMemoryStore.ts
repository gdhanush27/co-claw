import { MemoryEngine } from '../memory/MemoryEngine';
import { AgentRole, SharedValue } from './types';

const SHARED_TAG_PREFIX = 'shared:';
const KEY_TAG_PREFIX = 'sharedkey:';

interface StoredPayload {
    key: string;
    value: string;
    writtenBy: AgentRole;
    writtenAt: number;
}

/**
 * Namespaced shared key/value store backed by the existing MemoryEngine.
 * Each entry is tagged with `shared:<runId>` and `sharedkey:<key>`.
 */
export class SharedMemoryStore {
    constructor(private readonly memoryEngine: MemoryEngine) {}

    async write(runId: string, key: string, value: string, writtenBy: AgentRole): Promise<void> {
        const payload: StoredPayload = { key, value, writtenBy, writtenAt: Date.now() };
        await this.memoryEngine.writeMemory(
            JSON.stringify(payload),
            'code_context',
            0.4,
            [`${SHARED_TAG_PREFIX}${runId}`, `${KEY_TAG_PREFIX}${key}`, `agent:${writtenBy}`],
            'manual',
            'longterm',
        );
    }

    async list(runId: string): Promise<SharedValue[]> {
        // searchMemory uses keyword search — passing the full tag as the keyword
        // surfaces entries whose tags include it.
        const entries = await this.memoryEngine.searchMemory(`${SHARED_TAG_PREFIX}${runId}`, 'longterm', true);
        const tag = `${SHARED_TAG_PREFIX}${runId}`;
        const matching = entries.filter(e => e.tags.includes(tag));
        const out: SharedValue[] = [];
        for (const e of matching) {
            try {
                const parsed = JSON.parse(e.content) as StoredPayload;
                out.push({
                    key: parsed.key,
                    value: parsed.value,
                    writtenBy: parsed.writtenBy,
                    writtenAt: parsed.writtenAt,
                });
            } catch {
                // Skip malformed entries
            }
        }
        // Sort newest-first
        return out.sort((a, b) => b.writtenAt - a.writtenAt);
    }

    async read(runId: string, key?: string): Promise<SharedValue[]> {
        const all = await this.list(runId);
        if (!key) { return all; }
        return all.filter(v => v.key === key);
    }
}
