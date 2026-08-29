// Hit-testing: click tolerance, resize vs move, locked bars, lane Y.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeIndexedEngine } from './helpers/engine-fixture.mjs';

const HOUR = 3600000;
const START = Date.parse('2026-05-04T00:00:00Z');

function makeHitEngine(allocations, overrides = {}) {
    const engine = makeIndexedEngine(allocations, overrides);
    engine.timeRange = { start: START, end: START + 48 * HOUR };
    engine._pixelsPerHour = 40;
    engine._pixelsPerMs = 40 / HOUR;
    engine._visibleWidth = 1050;
    engine.scrollX = 0;
    engine.scrollY = 0;
    engine._recomputeRowMetrics();
    return engine;
}

function bar(id, startHour, endHour, extra = {}) {
    return {
        id, resourceId: 'r0',
        startTime: START + startHour * HOUR,
        endTime: START + endHour * HOUR,
        ...extra
    };
}

test('_barAt hits the stacked upper lane and misses the lower one', () => {
    const engine = makeHitEngine([
        bar('low', 1, 4),
        bar('high', 1.5, 3.5)
    ]);
    const low = engine.allocations.find(a => a.id === 'low');
    const high = engine.allocations.find(a => a.id === 'high');
    const rowCenter = engine.getResourceToY(0) + engine._rowHeight(0) / 2;
    const h = engine.config.barHeight;
    const x = engine.getTimeToX((low.startTime + high.endTime) / 2);

    const upperY = rowCenter + engine._stackOffset(high);
    const lowerY = rowCenter + engine._stackOffset(low);
    assert.notEqual(upperY, lowerY);

    const hitUpper = engine._barAt(x, upperY);
    const hitLower = engine._barAt(x, lowerY);
    assert.equal(hitUpper && hitUpper.alloc.id, 'high');
    assert.equal(hitLower && hitLower.alloc.id, 'low');
});

test('_editZone is resize at the ends and move in the middle', () => {
    const engine = makeHitEngine([bar('a', 1, 4)], { config: { editResizeHandlePx: 6 } });
    const alloc = engine.allocations[0];
    const startX = engine.getTimeToX(alloc.startTime);
    const endX = engine.getTimeToX(alloc.endTime);
    const mid = (startX + endX) / 2;

    assert.equal(engine._editZone(alloc, startX), 'resize-start');
    assert.equal(engine._editZone(alloc, endX), 'resize-end');
    assert.equal(engine._editZone(alloc, mid), 'move');
});

test('_editZone is null for a locked bar', () => {
    const engine = makeHitEngine([bar('a', 1, 4)]);
    const alloc = engine.allocations[0];
    alloc.locked = true;
    const mid = engine.getTimeToX((alloc.startTime + alloc.endTime) / 2);
    assert.equal(engine._editZone(alloc, mid), null);
});

test('_barAt ignores overflow bars', () => {
    const bars = [];
    for (let i = 0; i < 5; i++) bars.push(bar('a' + i, 1, 3));
    const engine = makeHitEngine(bars, { config: { maxStackLanes: 2 } });
    const overflow = engine.allocations.filter(a => engine._isOverflow(a));
    assert.ok(overflow.length > 0);
    const x = engine.getTimeToX(START + 2 * HOUR);
    const y = engine.getResourceToY(0) + engine._rowHeight(0) / 2;
    const hit = engine._barAt(x, y);
    assert.ok(hit);
    assert.equal(engine._isOverflow(hit.alloc), false);
});
