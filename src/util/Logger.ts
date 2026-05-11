import * as vscode from 'vscode';

/**
 * Centralized logger that writes to a VS Code output channel instead of
 * `console.*`. The channel is created lazily on first use so import order
 * doesn't matter, and respects the `CoClaw.logging.level` setting:
 *
 *   - "off"   — suppress everything
 *   - "error" — only errors (default)
 *   - "warn"  — errors + warnings
 *   - "info"  — errors + warnings + informational messages
 *   - "debug" — everything, including debug traces
 *
 * Use named scopes ("CoClaw Telegram", "CoClaw Heartbeat", ...) so the
 * channel reads like a per-subsystem syslog. Falls back to console.* if
 * VS Code's output channel API is unavailable (e.g. unit tests).
 */
export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_RANK: Record<LogLevel, number> = {
    off: 0, error: 1, warn: 2, info: 3, debug: 4,
};

let channel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel | undefined {
    if (channel) { return channel; }
    try {
        channel = vscode.window.createOutputChannel('CoClaw');
    } catch {
        channel = undefined;
    }
    return channel;
}

function getLevel(): LogLevel {
    try {
        const raw = vscode.workspace.getConfiguration('CoClaw.logging').get<string>('level', 'error');
        if (raw === 'off' || raw === 'error' || raw === 'warn' || raw === 'info' || raw === 'debug') {
            return raw;
        }
    } catch {
        // settings unavailable in tests
    }
    return 'error';
}

function log(level: Exclude<LogLevel, 'off'>, scope: string, message: string): void {
    if (LEVEL_RANK[getLevel()] < LEVEL_RANK[level]) { return; }
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level.toUpperCase()}] [${scope}] ${message}`;
    const ch = getChannel();
    if (ch) {
        ch.appendLine(line);
        return;
    }
    // Fallback when running outside VS Code (mocha unit tests).
    if (level === 'error') { console.error(line); }
    else if (level === 'warn') { console.warn(line); }
    else { console.log(line); }
}

export const Logger = {
    error(scope: string, message: string, err?: unknown): void {
        const detail = err === undefined ? '' : ` :: ${err instanceof Error ? err.message : String(err)}`;
        log('error', scope, message + detail);
    },
    warn(scope: string, message: string): void {
        log('warn', scope, message);
    },
    info(scope: string, message: string): void {
        log('info', scope, message);
    },
    debug(scope: string, message: string): void {
        log('debug', scope, message);
    },
    /** Test/cleanup helper; resets cached channel. */
    _resetForTests(): void {
        channel = undefined;
    },
};
