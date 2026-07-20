// Allocation indexing, stacking lanes and incremental re-indexing on edit.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    makeBareEngine, makeIndexedEngine, indexViolations, indexSnapshot,
    rng, genAllocations
} from './helpers/engine-fixture.mjs';

const RESOURCES = ['r0', 'r1', 'r2', 'r3'];

function alloc(id, resourceId, startTime, endTime, extra = {}) {
    return { id, resourceId, startTime, endTime, ...extra };
}

test('index groups allocations by resource, sorted by start time', () => {
    const engine = makeIndexedEngine([
        alloc('c', 'r1', 300, 400),
        alloc('a', 'r1', 100, 200),
        alloc('b', 'r2', 150, 250)
    ]);

    assert.deepEqual(engine.allocationsByResource.get('r1').items.map(a => a.id), ['a', 'c']);
    assert.deepEqual(engine.allocationsByResource.get('r2').items.map(a => a.id), ['b']);
    assert.deepEqual(indexViolations(engine), []);
});

test('row scan bounds cover the widest effective span in that row only', () => {
    const engine = makeIndexedEngine([
        // A very long bar in r0 must not widen r1's bounds.
        alloc('long', 'r0', 0, 1000000),
        alloc('short', 'r1', 500, 600, { startBar: { duration: 50 } })
    ]);

    assert.equal(engine.allocationsByResource.get('r0').maxSpanMs, 1000000);
    assert.equal(engine.allocationsByResource.get('r1').maxSpanMs, 150);
    assert.equal(engine.allocationsByResource.get('r1').maxStartEdgeMs, 50);
    assert.equal(engine.allocationsByResource.get('r0').maxStartEdgeMs, 0);
});

test('_firstVisibleAllocationIndex never skips an allocation that is in view', () => {
    const rand = rng(7);
    const allocations = genAllocations(rand, 300, ['r0']);
    const engine = makeIndexedEngine(allocations);
    const row = engine.allocationsByResource.get('r0');

    for (let visStart = 0; visStart < 1000000; visStart += 9973) {
        const first = engine._firstVisibleAllocationIndex(row, visStart);
        // Everything before the returned index must end before the window.
        for (let i = 0; i < first; i++) {
            const a = row.items[i];
            const ee = a.endBar && a.endBar.duration > 0 ? a.endBar.duration : 0;
            assert.ok(a.endTime + ee < visStart,
                `allocation ${a.id} ends at ${a.endTime + ee} but was skipped for window ${visStart}`);
        }
    }
});

test('non-overlapping bars all sit on the row centre line', () => {
    const engine = makeIndexedEngine([
        alloc('a', 'r0', 0, 100),
        alloc('b', 'r0', 100, 200),   // touching, not overlapping
        alloc('c', 'r0', 300, 400)
    ]);
    for (const a of engine.allocations) {
        assert.equal(engine._stackOffset(a), 0);
    }
});

test('overlapping bars are stacked into distinct lanes around the centre', () => {
    const engine = makeIndexedEngine([
        alloc('a', 'r0', 0, 100),
        alloc('b', 'r0', 50, 150),
        alloc('c', 'r0', 60, 160)
    ]);
    const offsets = engine.allocations.map(a => engine._stackOffset(a));
    assert.equal(new Set(offsets).size, 3, 'three overlapping bars need three lanes');
    // Symmetric about the row centre.
    assert.ok(Math.abs(offsets.reduce((s, o) => s + o, 0)) < 1e-9);
});

test('a fully overlapping row assigns one lane per bar', () => {
    // The degenerate case the lane-end lower bound short-circuits.
    const allocations = [];
    for (let i = 0; i < 200; i++) allocations.push(alloc('a' + i, 'r0', i, 100000));
    const engine = makeIndexedEngine(allocations);
    const lanes = new Set(engine.allocations.map(a => engine._laneInfo.get(a).lane));
    assert.equal(lanes.size, 200);
});

test('stacking offsets follow barHeight/barMargin changes', () => {
    const engine = makeIndexedEngine([
        alloc('a', 'r0', 0, 100),
        alloc('b', 'r0', 50, 150)
    ]);
    const before = engine.allocations.map(a => engine._stackOffset(a));

    engine.config.barMargin = 20;
    engine._barLayoutGen++;
    const after = engine.allocations.map(a => engine._stackOffset(a));

    assert.notDeepEqual(before, after, 'a larger margin must spread the lanes apart');
    assert.ok(Math.abs(after[0] - after[1]) > Math.abs(before[0] - before[1]));
});

test('lane state is not written onto the caller\'s allocation objects', () => {
    const a = alloc('a', 'r0', 0, 100);
    const b = alloc('b', 'r0', 50, 150);
    makeIndexedEngine([a, b]);
    for (const obj of [a, b]) {
        assert.deepEqual(
            Object.keys(obj).sort(),
            ['endTime', 'id', 'resourceId', 'startTime'],
            'the engine must not decorate host-owned allocation objects'
        );
    }
});

test('incremental re-index matches a full rebuild across random edits', () => {
    for (let seed = 1; seed <= 60; seed++) {
        const rand = rng(seed);
        const engine = makeIndexedEngine(genAllocations(rand, 40, RESOURCES));

        for (let step = 0; step < 20; step++) {
            const target = engine.allocations[Math.floor(rand() * engine.allocations.length)];
            const prevResourceId = target.resourceId;
            const prevStartTime = target.startTime;

            const kind = rand();
            if (kind < 0.4) {
                const delta = Math.floor((rand() - 0.5) * 200000);
                target.startTime += delta;
                target.endTime += delta;
            } else if (kind < 0.7) {
                target.endTime = target.startTime + 1 + Math.floor(rand() * 80000);
            } else if (kind < 0.85) {
                target.startTime = target.endTime - 1 - Math.floor(rand() * 80000);
            } else {
                target.resourceId = RESOURCES[Math.floor(rand() * RESOURCES.length)];
            }

            engine._reindexAllocation(target, prevResourceId, prevStartTime);

            assert.deepEqual(indexViolations(engine), [],
                `seed ${seed} step ${step}: index invariants violated`);

            // Same allocations, rebuilt from scratch, must produce the same
            // order, lanes and offsets.
            const rebuilt = makeIndexedEngine(engine.allocations.map(a => ({ ...a })));
            assert.deepEqual(indexSnapshot(engine), indexSnapshot(rebuilt),
                `seed ${seed} step ${step}: incremental index diverged from a full rebuild`);
        }
    }
});

test('editing an allocation onto a resource with no allocations yet works', () => {
    const engine = makeIndexedEngine([alloc('a', 'r0', 100, 200)]);
    const target = engine.allocations[0];
    target.resourceId = 'brand-new';
    engine._reindexAllocation(target, 'r0', 100);

    assert.deepEqual(engine.allocationsByResource.get('brand-new').items.map(a => a.id), ['a']);
    assert.deepEqual(engine.allocationsByResource.get('r0').items, []);
    assert.deepEqual(indexViolations(engine), []);
});

test('allocations with identical start times are re-indexed individually', () => {
    const engine = makeIndexedEngine([
        alloc('a', 'r0', 100, 200),
        alloc('b', 'r0', 100, 300),
        alloc('c', 'r0', 100, 400)
    ]);
    const target = engine.allocations.find(a => a.id === 'b');
    target.startTime = 500;
    target.endTime = 600;
    engine._reindexAllocation(target, 'r0', 100);

    assert.deepEqual(engine.allocationsByResource.get('r0').items.map(a => a.id), ['a', 'c', 'b']);
    assert.deepEqual(indexViolations(engine), []);
});

test('empty resources return a usable empty row index', () => {
    const engine = makeBareEngine();
    const row = engine._rowIndexFor('nobody');
    assert.deepEqual(row.items, []);
    assert.equal(row.maxSpanMs, 0);
    assert.equal(engine._firstVisibleAllocationIndex(row, 12345), 0);
});
