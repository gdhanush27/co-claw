import * as assert from 'assert';
import { parseClock } from '../heartbeat/Heartbeat';

/**
 * Regression tests for the H4 heartbeat-window parser.
 *
 * The previous implementation used `Number(x) || default`. Because `0` is
 * falsy, an explicit "0" hour (e.g. midnight) was silently replaced with
 * the default. A user setting `activeHoursEnd = "00:00"` therefore had
 * their heartbeat fire from 08:00 - 22:00 instead of 08:00 - midnight.
 */
describe('Heartbeat parseClock', () => {
    it('parses a well-formed clock string', () => {
        assert.deepStrictEqual(parseClock('08:30', 0, 0), [8, 30]);
        assert.deepStrictEqual(parseClock('22:00', 0, 0), [22, 0]);
        assert.deepStrictEqual(parseClock('1:5', 0, 0), [1, 5]);
    });

    it('preserves an explicit 0 hour (the original bug)', () => {
        // BEFORE THE FIX: parseClock("00:00", 22, 0) returned [22, 0]
        // because Number("00") || 22 evaluates to 22.
        assert.deepStrictEqual(parseClock('00:00', 22, 0), [0, 0]);
        assert.deepStrictEqual(parseClock('0:00', 22, 0), [0, 0]);
    });

    it('preserves an explicit 0 minute', () => {
        assert.deepStrictEqual(parseClock('08:00', 0, 30), [8, 0]);
    });

    it('falls back to BOTH defaults when input is entirely missing / unparseable', () => {
        assert.deepStrictEqual(parseClock('foo:bar', 9, 15), [9, 15]);
        assert.deepStrictEqual(parseClock('', 9, 15), [9, 15]);
        assert.deepStrictEqual(parseClock('   ', 9, 15), [9, 15]);
        assert.deepStrictEqual(parseClock(undefined, 9, 15), [9, 15]);
    });

    it('treats a present hour with missing minute as HH:00 (not the default minute)', () => {
        // Intentional: "14" reads naturally as 14:00. If the minute is
        // genuinely unparseable (`14:foo`) we fall back to defaultM.
        assert.deepStrictEqual(parseClock('14', 9, 15), [14, 0]);
        assert.deepStrictEqual(parseClock('14:foo', 9, 15), [14, 15]);
    });

    it('clamps out-of-range values rather than letting them propagate', () => {
        assert.deepStrictEqual(parseClock('25:99', 0, 0), [23, 59]);
        assert.deepStrictEqual(parseClock('-5:-3', 0, 0), [0, 0]);
    });

    it('floors fractional inputs to keep arithmetic stable downstream', () => {
        assert.deepStrictEqual(parseClock('12.7:30.4', 0, 0), [12, 30]);
    });
});
