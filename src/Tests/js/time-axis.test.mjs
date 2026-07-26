// Zone-aware time axis: hour-boundary generation, DST handling and tick
// density. These run against Intl, so they depend only on the ICU data Node
// ships with.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeBareEngine, ZonedTime } from './helpers/engine-fixture.mjs';

// Oracle: scan the window minute by minute and keep every instant whose local
// wall clock reads mm:ss = 00:00 on an hour that is a multiple of `step`. Zone
// offsets are always whole minutes, so this cannot miss a boundary. It is
// deliberately naive - its job is to be obviously correct, not fast.
function referenceBoundaries(engine, visStart, visEnd, step) {
    const out = [];
    for (let ts = Math.ceil(visStart / 60000) * 60000; ts <= visEnd; ts += 60000) {
        const p = engine.parts(ts);
        if (p.minute === 0 && p.second === 0 && p.hour % step === 0) {
            out.push({ ts, hour: p.hour });
        }
    }
    return out;
}

const ZONES = ['UTC', 'Europe/Berlin', 'America/New_York', 'Asia/Tokyo', 'Asia/Kolkata'];
const STEPS = [1, 2, 3, 4, 6, 8, 12, 24];

test('hour boundaries match a brute-force scan across zones and steps', () => {
    // An ordinary window with no transition in it.
    const start = Date.parse('2026-04-01T00:00:00Z');
    const end = Date.parse('2026-04-03T00:00:00Z');

    for (const zone of ZONES) {
        const engine = new ZonedTime(zone);
        for (const step of STEPS) {
            assert.deepEqual(
                engine.hourBoundaries(start, end, step),
                referenceBoundaries(engine, start, end, step),
                `zone ${zone}, step ${step}`
            );
        }
    }
});

test('hour boundaries handle an unaligned window start', () => {
    const start = Date.parse('2026-01-15T06:37:11Z');
    const end = Date.parse('2026-01-16T19:04:53Z');
    for (const zone of ZONES) {
        const engine = new ZonedTime(zone);
        for (const step of STEPS) {
            const got = engine.hourBoundaries(start, end, step);
            assert.deepEqual(got, referenceBoundaries(engine, start, end, step),
                `zone ${zone}, step ${step}`);
            for (const b of got) {
                assert.ok(b.ts >= start && b.ts <= end, 'boundary outside the requested window');
            }
        }
    }
});

test('a spring-forward transition does not emit the skipped wall-clock hour', () => {
    // 2026-03-08: New York jumps 02:00 -> 03:00, so local 02:00 never happens.
    const engine = new ZonedTime('America/New_York');
    const start = Date.parse('2026-03-08T04:00:00Z');
    const end = Date.parse('2026-03-08T10:00:00Z');
    const got = engine.hourBoundaries(start, end, 1);

    assert.deepEqual(got, referenceBoundaries(engine, start, end, 1));
    assert.ok(!got.some(b => b.hour === 2), 'local 02:00 does not exist on this date');
    // Every emitted boundary really is on the hour it claims.
    for (const b of got) {
        assert.equal(engine.parts(b.ts).hour, b.hour);
        assert.equal(engine.parts(b.ts).minute, 0);
    }
});

test('a spring-forward transition terminates (regression: non-advancing walk)', () => {
    // The previous implementation stopped advancing across this transition and
    // looped until an iteration cap bailed it out, truncating the axis.
    for (const zone of ['America/New_York', 'Europe/Berlin', 'America/St_Johns']) {
        const engine = new ZonedTime(zone);
        const start = Date.parse('2026-03-01T00:00:00Z');
        const end = Date.parse('2026-04-05T00:00:00Z');
        const got = engine.hourBoundaries(start, end, 1);
        // ~35 days of hourly boundaries, minus the one skipped hour.
        assert.ok(got.length > 800, `${zone}: only ${got.length} boundaries - walk stalled?`);
        for (let i = 1; i < got.length; i++) {
            assert.ok(got[i].ts > got[i - 1].ts, `${zone}: boundaries not strictly increasing`);
        }
    }
});

test('a fall-back transition keeps boundaries strictly increasing', () => {
    const engine = new ZonedTime('America/New_York');
    const start = Date.parse('2026-11-01T00:00:00Z');
    const end = Date.parse('2026-11-02T12:00:00Z');
    const got = engine.hourBoundaries(start, end, 1);

    for (let i = 1; i < got.length; i++) {
        assert.ok(got[i].ts > got[i - 1].ts, 'boundaries must advance in real time');
        assert.equal(engine.parts(got[i].ts).minute, 0);
    }
    // The repeated wall-clock hour is emitted once, leaving a two-hour real gap.
    const gaps = got.slice(1).map((b, i) => b.ts - got[i].ts);
    assert.equal(gaps.filter(g => g === 2 * 3600000).length, 1);
});

test('boundaries are bounded by the viewport, not the window length', () => {
    // _hourStep keeps ticks ~44px apart, so a very wide time window at a
    // readable zoom still yields only a screenful of boundaries.
    const time = new ZonedTime('UTC');
    const start = Date.parse('2026-01-01T00:00:00Z');
    const end = start + 400 * 24 * 3600000;   // 400 days

    // The step comes from the engine (it is a zoom concern), the boundaries
    // from ZonedTime.
    const engine = makeBareEngine();
    engine._pixelsPerHour = 2;                 // step will be 24
    const step = engine._hourStep();
    assert.equal(step, 24);
    const got = time.hourBoundaries(start, end, step);
    // Both ends of the window land exactly on midnight and the range is
    // inclusive, so 400 days spans 401 boundaries.
    assert.equal(got.length, 401);
    for (const b of got) assert.equal(b.hour, 0);
});

test('_hourStep picks tidy divisors of a day and bails out when unreadable', () => {
    const engine = makeBareEngine();
    const stepAt = (pph) => { engine._pixelsPerHour = pph; return engine._hourStep(); };

    assert.equal(stepAt(0.5), 0, 'a day narrower than 48px shows no hour ticks');
    for (const pph of [2, 3, 5, 8, 12, 20, 44, 100, 400]) {
        const step = stepAt(pph);
        assert.ok([1, 2, 3, 4, 6, 8, 12, 24].includes(step), `step ${step} is not a divisor of 24`);
        assert.equal(24 % step, 0);
    }
    // Denser zoom never needs a coarser step.
    let prev = 24;
    for (const pph of [2, 4, 8, 16, 32, 64]) {
        const step = stepAt(pph);
        assert.ok(step <= prev, 'step must not grow as the zoom increases');
        prev = step;
    }
});

test('zoned parts and the wall-clock round trip agree across a DST year', () => {
    for (const zone of ZONES) {
        const engine = new ZonedTime(zone);
        for (let day = 0; day < 365; day += 7) {
            const ts = Date.parse('2026-01-01T12:34:00Z') + day * 86400000;
            const p = engine.parts(ts);
            const round = engine.wallClockToTs(p.year, p.month, p.day, p.hour, p.minute, p.second);
            assert.equal(round, Math.floor(ts / 1000) * 1000,
                `${zone}: wall-clock round trip lost the instant at day ${day}`);
        }
    }
});

test('day boundaries are local midnight in the configured zone', () => {
    for (const zone of ZONES) {
        const engine = new ZonedTime(zone);
        let ts = engine.startOfDay(Date.parse('2026-06-15T09:00:00Z'));
        for (let i = 0; i < 40; i++) {
            const p = engine.parts(ts);
            assert.equal(p.hour, 0, `${zone}: day boundary is not local midnight`);
            assert.equal(p.minute, 0);
            const next = engine.nextDay(ts);
            assert.ok(next > ts, `${zone}: day walk did not advance`);
            ts = next;
        }
    }
});
