// Scene contract: bar ids, non-overlap within a row, working-time bands,
// Hour12 labels. Renderer paint needs a canvas; this locks the display list.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeBareEngine } from './helpers/engine-fixture.mjs';

const HOUR = 3600000;
const START = Date.parse('2026-05-04T00:00:00Z'); // Monday

function makeSceneEngine(allocations, overrides = {}) {
    const engine = makeBareEngine(overrides);
    engine._measureCtx = { font: '', measureText: (t) => ({ width: t.length * 7 }) };
    engine.config.timeZone = engine.config.timeZone || 'UTC';
    engine._rebuildDateFormatters();

    engine.resources = [
        { id: 'r0', name: 'Resource 0' },
        { id: 'r1', name: 'Resource 1' }
    ];
    engine._rebuildResourceStructure();

    engine.timeRange = { start: START, end: START + 48 * HOUR };
    engine.allocations = allocations.slice().sort((a, b) => a.startTime - b.startTime);
    engine._indexAllocations();

    engine._pixelsPerHour = 40;
    engine._pixelsPerMs = 40 / HOUR;
    engine._visibleWidth = 1050;
    engine.visibleTimeRange = engine.calculateVisibleTimeRange();
    return engine;
}

function bar(id, resourceId, startHour, endHour, extra = {}) {
    return {
        id, resourceId,
        startTime: START + startHour * HOUR,
        endTime: START + endHour * HOUR,
        ...extra
    };
}

function rectsOverlap(a, b) {
    return a.x < b.x + b.width && a.x + a.width > b.x
        && a.y < b.y + b.height && a.y + a.height > b.y;
}

test('buildScene bar ids match the fixture and do not overlap in a row', () => {
    const engine = makeSceneEngine([
        bar('a', 'r0', 1, 3),
        bar('b', 'r0', 1.5, 4),
        bar('c', 'r1', 2, 5)
    ]);
    const scene = engine.buildScene();
    assert.deepEqual(scene.bars.map(b => b.id).sort(), ['a', 'b', 'c']);

    const row0 = scene.bars.filter(b => b.id === 'a' || b.id === 'b');
    assert.equal(row0.length, 2);
    assert.equal(rectsOverlap(row0[0], row0[1]), false,
        'stacked bars in one row must not share the same rectangle');
});

test('Hour12 tick labels are 12-hour', () => {
    const engine = makeSceneEngine([bar('a', 'r0', 1, 3)], {
        config: { hour12: true, locale: 'en-US', timeZone: 'UTC' }
    });
    engine._rebuildDateFormatters();
    engine.visibleTimeRange = engine.calculateVisibleTimeRange();
    const scene = engine.buildScene();
    const labeled = scene.hourTicks.filter(t => t.label);
    assert.ok(labeled.length > 0);
    assert.ok(labeled.some(t => /AM|PM/i.test(t.label)));
});

test('UTC Sat–Sun span produces non-working weekend rects', () => {
    // 2026-05-09 is Saturday.
    const sat = Date.parse('2026-05-09T00:00:00Z');
    const engine = makeSceneEngine([bar('a', 'r0', 0, 1)], {
        config: { timeZone: 'UTC', nonWorkingDays: [0, 6] }
    });
    engine.timeRange = { start: sat, end: sat + 48 * HOUR };
    engine._rebuildDateFormatters();
    engine.visibleTimeRange = engine.calculateVisibleTimeRange();
    const scene = engine.buildScene();
    assert.ok(scene.nonWorking.length >= 1, 'weekend columns should be shaded');
});

test('09:00–17:00 working hours produce two off-hour bands per day', () => {
    const engine = makeSceneEngine([bar('a', 'r0', 0, 1)], {
        config: {
            timeZone: 'UTC',
            workingHoursStart: 9 * 60,
            workingHoursEnd: 17 * 60
        }
    });
    const scene = engine.buildScene();
    assert.ok(scene.nonWorking.length >= 2, 'morning and evening bands');
});
