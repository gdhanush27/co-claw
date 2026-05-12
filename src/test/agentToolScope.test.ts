import * as assert from 'assert';
import { AGENT_DEFINITIONS } from '../agents/AgentDefinitions';

/**
 * Regression tests for H1: tool-name scope checks used case-sensitive
 * comparisons against `'CoClaw_spawn_agent'` / `'CoClaw_shared_memory_read'`.
 * A model gateway that round-tripped tool names through lowercasing (or
 * any other case normalisation) could bypass the orchestrator-only and
 * planner-only restrictions, escalating into a planner sub-task or
 * fanning out new agents from a sandboxed role.
 */
describe('AgentDefinitions tool-scope case-insensitivity', () => {
    it('planner allows shared_memory_read regardless of name casing', () => {
        const allows = AGENT_DEFINITIONS.planner.allowsTool;
        assert.ok(allows('CoClaw_shared_memory_read'));
        assert.ok(allows('coclaw_shared_memory_read'));
        assert.ok(allows('CoClaw_Shared_Memory_Read'));
        assert.ok(allows('COCLAW_SHARED_MEMORY_READ'));
    });

    it('planner rejects every other tool', () => {
        const allows = AGENT_DEFINITIONS.planner.allowsTool;
        assert.ok(!allows('CoClaw_memory_write'));
        assert.ok(!allows('search_files'));
        assert.ok(!allows('CoClaw_spawn_agent'));
        // Even casing variations of denied tools must stay denied.
        assert.ok(!allows('coclaw_spawn_agent'));
    });

    it('coder cannot invoke spawn_agent regardless of casing', () => {
        const allows = AGENT_DEFINITIONS.coder.allowsTool;
        assert.ok(!allows('CoClaw_spawn_agent'));
        assert.ok(!allows('coclaw_spawn_agent'));
        assert.ok(!allows('CoClaw_Spawn_Agent'));
        assert.ok(!allows('COCLAW_SPAWN_AGENT'));
    });

    it('reviewer cannot invoke spawn_agent nor write/edit/delete tools', () => {
        const allows = AGENT_DEFINITIONS.reviewer.allowsTool;
        assert.ok(!allows('CoClaw_spawn_agent'));
        assert.ok(!allows('coclaw_spawn_agent'));
        assert.ok(!allows('write_file'));
        assert.ok(!allows('edit_file'));
        assert.ok(!allows('delete_files'));
        // But read-only tools are allowed.
        assert.ok(allows('search_files'));
        assert.ok(allows('CoClaw_shared_memory_read'));
    });

    it('coder allows ordinary tools (sanity check that the denylist is not too aggressive)', () => {
        const allows = AGENT_DEFINITIONS.coder.allowsTool;
        assert.ok(allows('write_file'));
        assert.ok(allows('search_files'));
        assert.ok(allows('run_terminal_command'));
    });
});
