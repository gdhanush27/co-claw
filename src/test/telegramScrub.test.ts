import * as assert from 'assert';
import { TelegramApi } from '../telegram/TelegramApi';

/**
 * Regression test for H3: bot tokens were embedded in Node's https errors
 * via the failed request URL (`/bot<TOKEN>/method`) and propagated all
 * the way to callers that logged `err.message`. The fix is to scrub the
 * token from any string and any Error.message / Error.stack before the
 * error escapes the API client.
 */
describe('TelegramApi token redaction', () => {
    const FAKE_TOKEN = '1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ0_1';
    let api: TelegramApi;
    beforeEach(() => { api = new TelegramApi(FAKE_TOKEN); });

    function scrub<T>(value: T): T {
        // Bracket access bypasses `private` for testing purposes — the
        // function is a pure helper and we want to assert its behaviour
        // without exercising the entire https stack.
        return (api as unknown as { scrubToken: <X>(v: X) => X }).scrubToken(value);
    }

    it('replaces the token inside a plain string', () => {
        const out = scrub(`Failed to POST /bot${FAKE_TOKEN}/getUpdates`);
        assert.ok(!out.includes(FAKE_TOKEN), 'raw token must not survive scrubbing');
        assert.ok(out.includes('<redacted-token>'));
        assert.ok(out.startsWith('Failed to POST /bot'));
        assert.ok(out.endsWith('/getUpdates'));
    });

    it('replaces every occurrence (Node sometimes repeats the URL)', () => {
        const out = scrub(`/bot${FAKE_TOKEN}/m1 and /bot${FAKE_TOKEN}/m2`);
        assert.ok(!out.includes(FAKE_TOKEN));
        assert.strictEqual((out.match(/<redacted-token>/g) ?? []).length, 2);
    });

    it('scrubs Error.message and Error.stack in place', () => {
        const err = new Error(`ENOTFOUND while requesting /bot${FAKE_TOKEN}/sendMessage`);
        const scrubbed = scrub(err);
        assert.strictEqual(scrubbed, err, 'should mutate the same error instance');
        assert.ok(!scrubbed.message.includes(FAKE_TOKEN));
        if (scrubbed.stack) {
            assert.ok(!scrubbed.stack.includes(FAKE_TOKEN), 'stack must also be scrubbed');
        }
    });

    it('passes through values that do not contain the token', () => {
        assert.strictEqual(scrub('no token here'), 'no token here');
        assert.strictEqual(scrub(42 as unknown as string), 42 as unknown as string);
    });

    it('handles an empty token gracefully (no infinite split loop)', () => {
        const emptyApi = new TelegramApi('');
        const out = (emptyApi as unknown as { scrubToken: (s: string) => string })
            .scrubToken('some message');
        assert.strictEqual(out, 'some message');
    });
});
