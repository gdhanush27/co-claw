import * as assert from 'assert';
import { describe, it } from 'mocha';
import {
    DEFAULT_MAX_TOOLS,
    isInteractiveUiTool,
    selectAutonomousTools,
} from '../lm/toolFilter';

interface ToolStub { name: string }

function range(prefix: string, count: number): ToolStub[] {
    return Array.from({ length: count }, (_, i) => ({ name: `${prefix}${String(i).padStart(3, '0')}` }));
}

describe('toolFilter.isInteractiveUiTool', () => {
    it('matches well-known interactive UI tool variants (case-insensitive substring)', () => {
        for (const n of [
            'simple_browser',
            'vscode_open_simple_browser',
            'copilot_openSimpleBrowser',
            'live_preview_show',
            'browser_screenshot',
            'click_element',
            'fill_form_field',
        ]) {
            assert.ok(isInteractiveUiTool(n), `expected ${n} to be flagged interactive`);
        }
    });

    it('does not match plain code tools', () => {
        for (const n of ['read_file', 'CoClaw_write_memory', 'codebase_search', 'apply_patch']) {
            assert.ok(!isInteractiveUiTool(n), `expected ${n} NOT to be flagged interactive`);
        }
    });
});

describe('toolFilter.selectAutonomousTools', () => {
    it('drops interactive-UI tools regardless of cap', () => {
        const registry: ToolStub[] = [
            { name: 'simple_browser' },
            { name: 'CoClaw_write_memory' },
            { name: 'browser_screenshot' },
            { name: 'read_file' },
        ];
        const out = selectAutonomousTools(registry, { max: 50 });
        const names = out.map(t => t.name);
        assert.deepStrictEqual(names.sort(), ['CoClaw_write_memory', 'read_file'].sort());
    });

    it('drops user-excluded tools (case-insensitive substring)', () => {
        const registry: ToolStub[] = [
            { name: 'mssql_query' },
            { name: 'MSSQL_Schema' },
            { name: 'jupyter_run_cell' },
            { name: 'CoClaw_recall' },
            { name: 'read_file' },
        ];
        const out = selectAutonomousTools(registry, { max: 50, exclude: ['mssql', 'jupyter'] });
        const names = out.map(t => t.name);
        assert.deepStrictEqual(names.sort(), ['CoClaw_recall', 'read_file'].sort());
    });

    it('keeps total under the cap and prefers CoClaw_* + core tools when truncating', () => {
        const registry: ToolStub[] = [
            ...range('zzz_noise_', 100),                   // 100 noisy tools that should drop first
            { name: 'CoClaw_write_memory' },
            { name: 'CoClaw_recall' },
            { name: 'read_file' },
            { name: 'apply_patch' },
            { name: 'grep_search' },
        ];
        const out = selectAutonomousTools(registry, { max: 10 });
        assert.strictEqual(out.length, 10);
        const names = out.map(t => t.name);
        // All 5 essentials must survive a tight cap.
        for (const must of ['CoClaw_write_memory', 'CoClaw_recall', 'read_file', 'apply_patch', 'grep_search']) {
            assert.ok(names.includes(must), `expected ${must} to survive the cap; got ${names.join(',')}`);
        }
        // The remaining 5 slots go to the noise tools, alphabetically.
        const remainder = names.filter(n => n.startsWith('zzz_noise_')).sort();
        assert.deepStrictEqual(remainder, [
            'zzz_noise_000', 'zzz_noise_001', 'zzz_noise_002', 'zzz_noise_003', 'zzz_noise_004',
        ]);
    });

    it('user priority bumps non-CoClaw tools above CoClaw_* when the cap is tight', () => {
        const registry: ToolStub[] = [
            ...range('aaa_other_', 50),
            { name: 'CoClaw_recall' },
            { name: 'must_have_github_pr_create' },
            { name: 'must_have_k8s_apply' },
        ];
        const out = selectAutonomousTools(registry, {
            max: 2,
            priority: ['must_have_github_pr', 'must_have_k8s'],
        });
        const names = out.map(t => t.name).sort();
        assert.deepStrictEqual(names, ['must_have_github_pr_create', 'must_have_k8s_apply']);
    });

    it('produces the same ordering across runs for cache stability', () => {
        const registry: ToolStub[] = [
            { name: 'tool_b' },
            { name: 'tool_a' },
            { name: 'CoClaw_recall' },
            { name: 'CoClaw_write_memory' },
            { name: 'read_file' },
        ];
        const a = selectAutonomousTools(registry, { max: 50 }).map(t => t.name);
        const b = selectAutonomousTools(registry, { max: 50 }).map(t => t.name);
        assert.deepStrictEqual(a, b);
        // Tier order: CoClaw_* alphabetic, then core (read_file), then the rest alphabetic.
        assert.deepStrictEqual(a, ['CoClaw_recall', 'CoClaw_write_memory', 'read_file', 'tool_a', 'tool_b']);
    });

    it('clamps absurd cap values into a safe range', () => {
        const registry = range('t_', 50);
        const tooSmall = selectAutonomousTools(registry, { max: 0 });
        assert.strictEqual(tooSmall.length, 1, 'cap of 0 must be clamped to at least 1');
        const huge = selectAutonomousTools(registry, { max: 999_999 });
        assert.strictEqual(huge.length, 50, 'cap above registry size must keep everything');
    });

    it('exposes a sane default cap below the model-side 128 limit', () => {
        assert.ok(DEFAULT_MAX_TOOLS > 0 && DEFAULT_MAX_TOOLS < 128,
            `default cap should leave headroom under the 128-tool provider limit; got ${DEFAULT_MAX_TOOLS}`);
    });
});
