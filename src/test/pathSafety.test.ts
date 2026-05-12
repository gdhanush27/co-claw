import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { isPathInside, isPathInsideAny } from '../util/pathSafety';

/**
 * Regression tests for the path-boundary fix (H2).
 *
 * The previous `startsWith(root + sep)` / `path.relative(...).startsWith('..')`
 * checks failed in two ways:
 *
 *   - On Windows, lexical comparison treated `C:\foo` and `c:\foo` as
 *     different prefixes, causing legitimate workspace files to be
 *     hidden from tools and (worse, in some flows) lexically-equal but
 *     drive-letter-cased paths to slip past.
 *   - Symlinks were not followed. A symlink inside the workspace pointing
 *     at `/etc` made `<wsRoot>/link/passwd` appear contained even though
 *     the real target lives outside the workspace.
 *
 * The new helper resolves both sides through `fs.realpathSync.native` and
 * falls back to `path.relative` (which is case-insensitive on win32) when
 * realpath fails because the path doesn't exist yet.
 */
describe('pathSafety.isPathInside', () => {
    let tmpRoot: string;

    before(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coclaw-pathsafety-'));
    });

    after(() => {
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    it('treats a path as inside itself', () => {
        assert.ok(isPathInside(tmpRoot, tmpRoot));
    });

    it('accepts a child path inside the root', () => {
        const child = path.join(tmpRoot, 'a', 'b', 'file.txt');
        fs.mkdirSync(path.dirname(child), { recursive: true });
        fs.writeFileSync(child, 'x');
        assert.ok(isPathInside(child, tmpRoot));
    });

    it('rejects a sibling path that is NOT inside', () => {
        const sibling = path.resolve(tmpRoot, '..', 'definitely-elsewhere-' + Date.now());
        assert.ok(!isPathInside(sibling, tmpRoot));
    });

    it('rejects parent-directory traversal via ".."', () => {
        const escapee = path.join(tmpRoot, 'inside', '..', '..', 'outside.txt');
        assert.ok(!isPathInside(escapee, tmpRoot));
    });

    it('rejects empty inputs', () => {
        assert.ok(!isPathInside('', tmpRoot));
        assert.ok(!isPathInside(tmpRoot, ''));
        assert.ok(!isPathInsideAny('anything', []));
    });

    it('works against multiple roots when ANY contains the candidate', () => {
        const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coclaw-pathsafety2-'));
        try {
            const child = path.join(otherRoot, 'file.txt');
            fs.writeFileSync(child, 'x');
            assert.ok(isPathInsideAny(child, [tmpRoot, otherRoot]));
            assert.ok(!isPathInsideAny(child, [tmpRoot]));
        } finally {
            try { fs.rmSync(otherRoot, { recursive: true, force: true }); } catch { /* best effort */ }
        }
    });

    it('accepts not-yet-existing paths whose ancestors exist (file-write tools)', () => {
        // The tool is about to CREATE the file. realpath will throw because
        // the leaf doesn't exist yet — the helper should fall back to
        // ancestor resolution.
        const future = path.join(tmpRoot, 'about-to-create.txt');
        assert.ok(!fs.existsSync(future), 'pre-check: file should not exist yet');
        assert.ok(isPathInside(future, tmpRoot));
    });

    // Symlinks are intentionally NOT exercised on Windows: the test runner
    // typically lacks the required Developer Mode / admin privileges and
    // `fs.symlinkSync` throws EPERM, which would make the test flaky.
    const canSymlink = process.platform !== 'win32';
    (canSymlink ? it : it.skip)(
        'rejects a symlink that escapes the workspace (the original bypass)',
        () => {
            const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coclaw-external-'));
            try {
                fs.writeFileSync(path.join(externalDir, 'secret.txt'), 'top secret');
                const linkPath = path.join(tmpRoot, 'escape-hatch');
                fs.symlinkSync(externalDir, linkPath, 'dir');
                const targetThroughLink = path.join(linkPath, 'secret.txt');
                // The OLD lexical check would have accepted this path.
                // The realpath-based check must reject it.
                assert.ok(!isPathInside(targetThroughLink, tmpRoot));
            } finally {
                try { fs.rmSync(externalDir, { recursive: true, force: true }); } catch { /* best effort */ }
            }
        },
    );
});
