// Scene building. The scene object, its arrays and the bar nodes inside it are
// pooled and refilled in place each frame, so these tests focus on the failure
// mode that introduces: state left over from a previous frame surfacing on a
// bar that should not have it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeBareEngine } from './helpers/engine-fixture.mjs';

const HOUR = 3600000;
const START = Date.parse('2026-05-04T00:00:00Z');

// buildScene measures day labels through a 2D context. That is the only DOM it
// touches, so a stub with a plausible metric makes the whole path testable.
function makeSceneEngine(allocations, overrides = {}) {
    const engine = makeBareEngine(overrides);
    engine._measureCtx = { font: '', measureText: (t) => ({ width: t.length * 7 }) };
    engine.config.timeZone = 'UTC';
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

test('a scene carries the visible bars with resolved geometry', () => {
    const engine = makeSceneEngine([bar('a', 'r0', 1, 3), bar('b', 'r1', 2, 4)]);
    const scene = engine.buildScene();

    assert.deepEqual(scene.bars.map(b => b.id), ['a', 'b']);
    for (const b of scene.bars) {
        assert.ok(b.width > 0, 'bars need a positive drawn width');
        assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y));
    }
    assert.ok(scene.hourTicks.length > 0, 'the hour row should have ticks at this zoom');
    assert.ok(scene.days.length > 0, 'the date row should have at least one day');
});

test('the scene config is a frozen snapshot, not the live config', () => {
    const engine = makeSceneEngine([bar('a', 'r0', 1, 3)]);
    const scene = engine.buildScene();

    assert.ok(Object.isFrozen(scene.config));
    engine.config.barHeight = 99;
    assert.notEqual(scene.config.barHeight, 99,
        'a scene must not observe config changes made after it was built');
});

test('a selection outline does not persist onto a later unselected bar', () => {
    // The pooled bar node that carried the outline is reused next frame.
    const engine = makeSceneEngine([bar('a', 'r0', 1, 3)]);
    engine.selectedBars.add('a');
    const first = engine.buildScene();
    assert.ok(first.bars[0].outline, 'the selected bar should have an outline');

    engine.selectedBars.clear();
    const second = engine.buildScene();
    assert.equal(second.bars[0].outline, null,
        'the reused node must not keep the previous frame\'s outline');
    assert.equal(second.bars[0].selected, false);
});

test('a focus ring does not persist onto a later unfocused bar', () => {
    const engine = makeSceneEngine([bar('a', 'r0', 1, 3)]);
    engine._hasFocus = true;
    engine._focusAlloc = engine.allocations[0];
    assert.ok(engine.buildScene().bars[0].focusRing);

    engine._hasFocus = false;
    assert.equal(engine.buildScene().bars[0].focusRing, null);
});

test('edge bars do not persist onto a later bar without them', () => {
    const withEdges = makeSceneEngine([
        bar('a', 'r0', 1, 3, { startBar: { duration: HOUR, color: 'red' } })
    ]);
    assert.equal(withEdges.buildScene().bars[0].edges.length, 1);

    // Same engine, same pooled node, but the allocation no longer has an edge.
    withEdges.allocations[0].startBar = null;
    withEdges._indexAllocations();
    const scene = withEdges.buildScene();
    assert.equal(scene.bars[0].edges, null, 'the reused node must not keep stale edge bars');
});

test('labels do not persist onto a later bar without them', () => {
    const engine = makeSceneEngine([bar('a', 'r0', 1, 6, { textAbove: 'hello' })]);
    assert.deepEqual(engine.buildScene().bars[0].labels.map(l => l.text), ['hello']);

    engine.allocations[0].textAbove = null;
    const scene = engine.buildScene();
    assert.equal(scene.bars[0].labels, null, 'the reused node must not keep stale labels');
});

test('a bar with fewer labels than last frame does not accumulate them', () => {
    // The backing array is reused, so it has to be cleared rather than appended
    // to - otherwise labels pile up frame after frame.
    const engine = makeSceneEngine([
        bar('a', 'r0', 1, 6, { textAbove: 'above', textBelow: 'below' })
    ]);
    assert.equal(engine.buildScene().bars[0].labels.length, 2);
    assert.equal(engine.buildScene().bars[0].labels.length, 2, 'a repeat frame must not grow the list');

    engine.allocations[0].textBelow = null;
    assert.deepEqual(engine.buildScene().bars[0].labels.map(l => l.text), ['above']);
});

test('a bar with fewer icons than last frame does not accumulate them', () => {
    const engine = makeSceneEngine([
        bar('a', 'r0', 1, 6, {
            icons: [
                { source: 'one.png', position: 'start' },
                { source: 'two.png', position: 'end' }
            ]
        })
    ]);
    // Icons are only laid out once their image has loaded; stub the cache.
    const loaded = { complete: true, naturalWidth: 16, naturalHeight: 16 };
    engine._getImage = () => loaded;

    assert.equal(engine.buildScene().bars[0].icons.length, 2);
    assert.equal(engine.buildScene().bars[0].icons.length, 2, 'a repeat frame must not grow the list');

    engine.allocations[0].icons = [{ source: 'one.png', position: 'start' }];
    assert.equal(engine.buildScene().bars[0].icons.length, 1);
});

test('edge bars from one bar do not leak into the next bar in the same frame', () => {
    // Two bars share the pool; the second must start clean even though the
    // first filled its backing arrays.
    const engine = makeSceneEngine([
        bar('a', 'r0', 1, 3, { startBar: { duration: HOUR, color: 'red' }, textAbove: 'x' }),
        bar('b', 'r0', 10, 12)
    ]);
    const scene = engine.buildScene();
    const [first, second] = scene.bars;

    assert.equal(first.id, 'a');
    assert.equal(second.id, 'b');
    assert.ok(first.edges && first.edges.length === 1);
    assert.equal(second.edges, null);
    assert.equal(second.labels, null);
});

test('a shrinking frame does not leave stale bars or rows behind', () => {
    const engine = makeSceneEngine([
        bar('a', 'r0', 1, 3), bar('b', 'r0', 5, 7), bar('c', 'r1', 2, 4)
    ]);
    assert.equal(engine.buildScene().bars.length, 3);

    engine.allocations = [engine.allocations[0]];
    engine._indexAllocations();
    const scene = engine.buildScene();
    assert.equal(scene.bars.length, 1);
    assert.deepEqual(scene.bars.map(b => b.id), ['a']);
});

test('resource rows shrink when a group collapses', () => {
    const engine = makeSceneEngine([]);
    engine.resources = [
        { id: 'g', name: 'Group' },
        { id: 'c1', name: 'Child 1', parentId: 'g' },
        { id: 'c2', name: 'Child 2', parentId: 'g' }
    ];
    engine._rebuildResourceStructure();
    assert.equal(engine.buildScene().resourceRows.length, 3);

    engine._collapsed.add('g');
    engine._rebuildRows();
    const scene = engine.buildScene();
    assert.equal(scene.resourceRows.length, 1);
    assert.equal(scene.resourceRows[0].name, 'Group');
    assert.equal(scene.resourceRows[0].collapsed, true);
});

test('resource rows are omitted entirely when an HTML template renders them', () => {
    const engine = makeSceneEngine([]);
    engine.config.resourceTemplate = true;
    assert.equal(engine.buildScene().resourceRows, null);
});

test('the marquee and ghost are absent unless an interaction is in progress', () => {
    const engine = makeSceneEngine([bar('a', 'r0', 1, 3)]);
    const scene = engine.buildScene();
    assert.equal(scene.marquee, null);
    assert.equal(scene.ghost, null);
});

test('a marquee is cleared from the scene once the drag ends', () => {
    const engine = makeSceneEngine([bar('a', 'r0', 1, 3)]);
    engine.drag = { startX: 10, startY: 10, currentX: 200, currentY: 120, moved: true };
    const during = engine.buildScene();
    assert.ok(during.marquee);
    assert.ok(during.marquee.width > 0 && during.marquee.height > 0);

    engine.drag = null;
    assert.equal(engine.buildScene().marquee, null);
});

test('bars outside the visible time range are culled', () => {
    const engine = makeSceneEngine([bar('near', 'r0', 1, 2), bar('far', 'r0', 40, 42)]);
    const ids = engine.buildScene().bars.map(b => b.id);
    assert.ok(ids.includes('near'));
    assert.ok(!ids.includes('far'), 'a bar well past the viewport should be culled');
});

test('grid lines line up with the hour ticks', () => {
    const engine = makeSceneEngine([]);
    const scene = engine.buildScene();
    assert.deepEqual(scene.gridV, scene.hourTicks.map(t => t.x));
});
