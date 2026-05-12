import * as path from 'path';
import * as fs from 'fs';

/**
 * Containment check that resolves both sides through `fs.realpathSync` so
 * symlinks cannot trick the comparison.
 *
 * Earlier the codebase used `startsWith(root + sep)` against unresolved
 * paths. That breaks in two ways:
 *
 *  1. Symlink traversal — a symlink inside the workspace pointing at
 *     `/etc` lets a tool read `<wsRoot>/link/passwd` even though the real
 *     target lives outside the workspace.
 *  2. Windows case sensitivity — `path.normalize` does NOT lowercase the
 *     drive letter (`C:\\` vs `c:\\`), so a legitimate file inside the
 *     workspace can falsely fail containment when the editor reports a
 *     drive-letter-lowercased URI.
 *
 * `realpath` resolves both — symlinks are followed and the OS reports the
 * canonical case for the file. When `realpath` throws (e.g. the candidate
 * path does not exist yet, common for file-write tools), the function
 * falls back to a case-aware textual check.
 */
export function isPathInsideAny(candidate: string, roots: readonly string[]): boolean {
    if (!candidate || roots.length === 0) { return false; }
    const resolvedCandidate = resolveSafe(candidate);
    return roots.some(root => isInsideOne(resolvedCandidate, resolveSafe(root)));
}

/** Same as {@link isPathInsideAny} for a single root — convenient shorthand. */
export function isPathInside(candidate: string, root: string): boolean {
    return isPathInsideAny(candidate, [root]);
}

function isInsideOne(candidate: string, root: string): boolean {
    if (!candidate || !root) { return false; }
    // Use path.relative which is case-insensitive on Win32 by default —
    // exactly the behavior we want, and matches how Node resolves modules.
    // A negative result starts with `..` (escapes the root) or is absolute
    // (different drive on Windows).
    const rel = path.relative(root, candidate);
    if (rel === '' ) { return true; }
    if (rel.startsWith('..' + path.sep) || rel === '..') { return false; }
    if (path.isAbsolute(rel)) { return false; }
    return true;
}

/**
 * Realpath-resolve a path. On failure, fall back to lexical normalization
 * with platform-aware case folding so the check still works for paths that
 * haven't been created yet (file-write tools).
 */
function resolveSafe(p: string): string {
    try {
        return fs.realpathSync.native(p);
    } catch {
        // Path likely doesn't exist yet. Best-effort: normalize the
        // ancestors that DO exist, then re-attach the unresolved tail. This
        // catches the common case where someone is about to create a file
        // inside a real workspace dir.
        return resolveLongestExisting(p);
    }
}

function resolveLongestExisting(p: string): string {
    const norm = path.normalize(p);
    let head = norm;
    const tail: string[] = [];
    // Walk up until realpath succeeds or we run out of parents.
    let safety = 0;
    while (safety++ < 1024) {
        try {
            const resolved = fs.realpathSync.native(head);
            return tail.length === 0 ? resolved : path.join(resolved, ...tail.reverse());
        } catch {
            const parent = path.dirname(head);
            if (parent === head) { break; }
            tail.push(path.basename(head));
            head = parent;
        }
    }
    return norm;
}
