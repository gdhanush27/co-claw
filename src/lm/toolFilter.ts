import * as vscode from 'vscode';
import { Logger } from '../util/Logger';

/**
 * Tools that pop up a VS Code UI prompt (e.g. "Share an existing browser tab?",
 * "Open in simple browser?") and therefore can't progress unattended. They
 * hang the run waiting for human input that will never come in headless
 * surfaces (Telegram bridge, scheduled cron jobs, heartbeat agent loop). The
 * VS Code chat surface also hits this when the user is away from the IDE.
 *
 * Match is case-insensitive substring so vendor-prefixed variants like
 * `vscode_open_simple_browser`, `copilot_openSimpleBrowser`, etc. are caught.
 */
export const INTERACTIVE_UI_TOOL_PATTERNS: readonly string[] = [
    'simple_browser', 'simplebrowser',
    'open_browser', 'openbrowser', 'browser_page', 'browserpage',
    'live_preview', 'livepreview',
    'open_preview', 'openpreview',
    'webview', 'web_view',
    'screenshot',
    'click_element', 'fill_form',
    'open_terminal', 'openterminal',
];

/**
 * Hard ceiling for the number of tools we will pass to a single
 * `model.sendRequest` call. Most LM providers cap at 128 (OpenAI, Gemini); a
 * few are stricter. We default to 120 to leave headroom in case the platform
 * adds implicit tools to the request behind our back.
 *
 * Override at runtime via `CoClaw.tools.maxPerRequest` (1..256).
 */
export const DEFAULT_MAX_TOOLS = 120;
const ABSOLUTE_MAX_TOOLS = 256;

/**
 * Substring patterns (case-insensitive) for tools that almost every coding
 * task wants. Matched after the CoClaw-prefixed must-haves so they survive
 * the cap when the global registry is huge (many MCP servers / extensions).
 */
const CORE_TOOL_PATTERNS: readonly string[] = [
    'read_file', 'readfile',
    'write_file', 'writefile', 'create_file', 'createfile',
    'edit_file', 'editfile', 'apply_patch', 'applypatch', 'str_replace', 'strreplace',
    'list_dir', 'listdir', 'list_directory', 'listdirectory',
    'search', 'grep', 'glob', 'find_files', 'findfiles',
    'codebase', 'semantic_search', 'semanticsearch',
    'run_terminal', 'runterminal', 'terminal_command', 'terminalcommand',
    'shell',
    'fetch', 'web_search', 'websearch',
];

/** Returns true if the named tool requires interactive VS Code UI to complete. */
export function isInteractiveUiTool(name: string): boolean {
    const n = name.toLowerCase();
    return INTERACTIVE_UI_TOOL_PATTERNS.some(p => n.includes(p));
}

/** Read CoClaw.tools.* config with defensive fallbacks for non-VS-Code envs (tests). */
function readConfig(): { max: number; exclude: string[]; priority: string[] } {
    let cfg: vscode.WorkspaceConfiguration | undefined;
    try { cfg = vscode.workspace.getConfiguration('CoClaw.tools'); }
    catch { cfg = undefined; }

    const rawMax = cfg?.get<number>('maxPerRequest', DEFAULT_MAX_TOOLS) ?? DEFAULT_MAX_TOOLS;
    const max = Number.isFinite(rawMax)
        ? Math.max(1, Math.min(ABSOLUTE_MAX_TOOLS, Math.floor(rawMax)))
        : DEFAULT_MAX_TOOLS;

    const exclude = (cfg?.get<string[]>('exclude', []) ?? [])
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .map(s => s.toLowerCase());

    const priority = (cfg?.get<string[]>('priority', []) ?? [])
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .map(s => s.toLowerCase());

    return { max, exclude, priority };
}

function tierFor(name: string, userPriority: readonly string[]): 0 | 1 | 2 | 3 {
    const n = name.toLowerCase();
    if (userPriority.some(p => n.includes(p))) { return 0; }
    if (n.startsWith('coclaw_') || n.startsWith('coclaw.')) { return 1; }
    if (CORE_TOOL_PATTERNS.some(p => n.includes(p))) { return 2; }
    return 3;
}

/**
 * Core selector: filters interactive-UI tools, applies user excludes, sorts
 * by priority tier, then truncates to the configured cap. Exposed for tests
 * (deterministic — no I/O, no clock).
 */
export function selectAutonomousTools(
    registry: ReadonlyArray<{ name: string }>,
    opts?: { max?: number; exclude?: readonly string[]; priority?: readonly string[] },
): vscode.LanguageModelChatTool[] {
    const cfg = readConfig();
    const rawMax = opts?.max ?? cfg.max;
    // Clamp every code path (config + direct callers + tests) to the same
    // safe range so a stray 0 or NaN can't silently empty the tool list.
    const max = Number.isFinite(rawMax)
        ? Math.max(1, Math.min(ABSOLUTE_MAX_TOOLS, Math.floor(rawMax)))
        : DEFAULT_MAX_TOOLS;
    const exclude = (opts?.exclude ?? cfg.exclude).map(s => s.toLowerCase());
    const priority = (opts?.priority ?? cfg.priority).map(s => s.toLowerCase());

    const filtered = registry.filter(t => {
        if (typeof t?.name !== 'string') { return false; }
        if (isInteractiveUiTool(t.name)) { return false; }
        const lc = t.name.toLowerCase();
        if (exclude.some(p => lc.includes(p))) { return false; }
        return true;
    });

    // Stable sort: tier asc, then alphabetic. This way two runs with the
    // same registry produce identical tool lists — important for cache hits.
    const sorted = [...filtered].sort((a, b) => {
        const ta = tierFor(a.name, priority);
        const tb = tierFor(b.name, priority);
        if (ta !== tb) { return ta - tb; }
        return a.name.localeCompare(b.name);
    });

    if (sorted.length <= max) {
        return sorted as vscode.LanguageModelChatTool[];
    }

    const kept = sorted.slice(0, max);
    const dropped = sorted.slice(max);
    Logger.warn(
        'toolFilter',
        `Tool registry has ${sorted.length} entries; capping to ${max} for the LM request. ` +
        `Dropped (first 10 of ${dropped.length}): ${dropped.slice(0, 10).map(t => t.name).join(', ')}. ` +
        `Adjust 'CoClaw.tools.maxPerRequest', 'CoClaw.tools.exclude', or 'CoClaw.tools.priority' to control selection.`,
    );
    return kept as vscode.LanguageModelChatTool[];
}

/**
 * Filter the global LM tool registry, dropping anything that needs a
 * blocking UI prompt and capping the total below the model-side limit.
 * Used by every surface that drives the model autonomously (chat
 * participant, Telegram bridge, multi-agent runs).
 */
export function getAutonomousTools(): vscode.LanguageModelChatTool[] {
    return selectAutonomousTools(vscode.lm.tools);
}
