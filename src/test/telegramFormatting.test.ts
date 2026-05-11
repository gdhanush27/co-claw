import * as assert from 'assert';
import { formatTelegramHtml, splitTelegramHtml, inlineCodeFromUserText } from '../telegram/TelegramFormatting';

describe('TelegramFormatting', () => {
    describe('formatTelegramHtml()', () => {
        it('formats bold, italic, inline code, and lists', () => {
            const input = [
                '# Release Notes',
                '',
                '*CoClaw Telegram Commands*',
                '- use `npm test`',
                '1. **Ship it**',
            ].join('\n');

            const result = formatTelegramHtml(input);

            assert.ok(result.includes('<b>Release Notes</b>'));
            assert.ok(result.includes('<i>CoClaw Telegram Commands</i>'));
            assert.ok(result.includes('• use <code>npm test</code>'));
            assert.ok(result.includes('1. <b>Ship it</b>'));
        });

        it('escapes html and preserves links', () => {
            const input = 'Open <config> and visit [docs](https://example.com/docs?a=1&b=2)';
            const result = formatTelegramHtml(input);

            assert.ok(result.includes('Open &lt;config&gt;'));
            assert.ok(result.includes('<a href="https://example.com/docs?a=1&amp;b=2">docs</a>'));
        });

        it('renders fenced code blocks as preformatted text', () => {
            const input = '```ts\nconst value = 1 < 2;\n```';
            const result = formatTelegramHtml(input);

            assert.strictEqual(result, '<pre>const value = 1 &lt; 2;</pre>');
        });

        it('preserves pre-existing Telegram HTML tags instead of escaping them', () => {
            // This is the critical fix: settings panels / inline help that build
            // strings with `<b>...</b>` already must not get those tags escaped
            // when run through the formatter.
            const input = '⚙️ <b>CoClaw Settings</b>\n• <i>Tap a category</i>: <code>memory</code>';
            const result = formatTelegramHtml(input);

            assert.ok(result.includes('<b>CoClaw Settings</b>'),
                `expected <b>...</b> preserved, got: ${result}`);
            assert.ok(result.includes('<i>Tap a category</i>'),
                `expected <i>...</i> preserved, got: ${result}`);
            assert.ok(result.includes('<code>memory</code>'),
                `expected <code>...</code> preserved, got: ${result}`);
            // Stray `<` from a non-allowed tag should still get escaped.
            assert.ok(!result.includes('&lt;b&gt;'),
                'safe <b> tag must not be double-escaped');
        });

        it('preserves anchor tags with href attributes', () => {
            const input = 'See <a href="https://example.com">docs</a> for details';
            const result = formatTelegramHtml(input);

            assert.ok(result.includes('<a href="https://example.com">docs</a>'));
        });

        it('preserves recognized HTML entities', () => {
            const input = 'Already escaped: &lt;tag&gt; &amp; raw: < and &';
            const result = formatTelegramHtml(input);

            // Existing entities preserved as-is.
            assert.ok(result.includes('&lt;tag&gt;'));
            assert.ok(result.includes('&amp;'));
            // Stray < and & still escaped.
            assert.ok(result.includes(' &lt; '));
            assert.ok(/raw: &lt; and &amp;$/.test(result.split('\n').pop() ?? result));
        });

        it('does not mangle cron expressions like "0 */2 * * *"', () => {
            // Previously the italic regex matched ` * * ` and turned cron
            // expressions into `0 <i>/2 </i> <i> </i>`.
            const input = 'Schedule: 0 */2 * * * Health check';
            const result = formatTelegramHtml(input);

            assert.ok(!result.includes('<i>'),
                `cron expression should not be italicized; got: ${result}`);
            assert.ok(result.includes('0 */2 * * * Health check'),
                `cron expression should be preserved verbatim; got: ${result}`);
        });

        it('still produces italic for legitimate single-asterisk emphasis', () => {
            const input = 'This is *important* text';
            const result = formatTelegramHtml(input);

            assert.ok(result.includes('<i>important</i>'),
                `expected single-asterisk italic to still work; got: ${result}`);
        });

        it('does not italicize a stray asterisk with no closing pair', () => {
            const input = 'See file *.ts for details';
            const result = formatTelegramHtml(input);

            // An asterisk followed immediately by `.` is not valid markdown
            // emphasis (no closing pair), so it should pass through unchanged.
            assert.ok(!result.includes('<i>'),
                `unmatched asterisk should not produce italic; got: ${result}`);
        });

        it('survives mixed nested HTML and markdown without producing &lt; for safe tags', () => {
            // Stress: a real settings/UI message that mixes pre-built HTML
            // with markdown emphasis and code, plus a stray `<` that MUST
            // get escaped. The combination has historically been the source
            // of double-escape regressions.
            const input = [
                '⚙️ <b>CoClaw Settings</b>',
                '',
                'Pick <i>a category</i> below or run `*` to see all:',
                '- <code>/memory</code> — **manage** memories',
                '- <code>/cron</code> — see *active* jobs',
                '',
                'Stray brackets like <unsupported> must escape, but <b>this</b> stays.',
            ].join('\n');
            const result = formatTelegramHtml(input);

            assert.ok(result.includes('<b>CoClaw Settings</b>'));
            assert.ok(result.includes('<i>a category</i>'));
            assert.ok(result.includes('<code>/memory</code>'));
            assert.ok(result.includes('<b>manage</b>'));
            assert.ok(result.includes('<code>/cron</code>'));
            assert.ok(result.includes('<i>active</i>'));
            // The unsupported tag should be escaped, not preserved.
            assert.ok(result.includes('&lt;unsupported&gt;'),
                `unsupported tag should be escaped; got: ${result}`);
            // ...but the safe <b>this</b> right after must NOT be escaped.
            assert.ok(result.includes('<b>this</b>'),
                `safe <b> tag must survive when adjacent to escaped one; got: ${result}`);
            // And no double-escapes anywhere
            assert.ok(!/&amp;lt;/.test(result),
                `must not produce &amp;lt; (double-escape); got: ${result}`);
        });
    });

    describe('inlineCodeFromUserText()', () => {
        it('wraps user text in <code> and escapes html-significant chars', () => {
            assert.strictEqual(
                inlineCodeFromUserText('<script>alert("x")</script>'),
                '<code>&lt;script&gt;alert("x")&lt;/script&gt;</code>',
            );
        });

        it('strips backticks so the snippet survives downstream parsing', () => {
            assert.strictEqual(
                inlineCodeFromUserText('weird `value` here'),
                '<code>weird value here</code>',
            );
        });
    });

    describe('splitTelegramHtml()', () => {
        it('splits long formatted messages without leaving dangling tags', () => {
            const repeated = Array.from({ length: 18 }, (_, index) => `**item ${index}**`).join(' ');
            const html = formatTelegramHtml(repeated);
            const chunks = splitTelegramHtml(html, 120);

            assert.ok(chunks.length > 1);
            for (const chunk of chunks) {
                assert.ok(chunk.length <= 120);
                assert.strictEqual((chunk.match(/<b>/g) ?? []).length, (chunk.match(/<\/b>/g) ?? []).length);
            }
        });

        it('keeps code blocks readable across splits', () => {
            const code = '```\n' + 'line\n'.repeat(80) + '```';
            const html = formatTelegramHtml(code);
            const chunks = splitTelegramHtml(html, 140);

            assert.ok(chunks.length > 1);
            for (const chunk of chunks) {
                assert.strictEqual((chunk.match(/<pre>/g) ?? []).length, (chunk.match(/<\/pre>/g) ?? []).length);
            }
        });
    });
});
