// Test fixture for the timeline engine.
//
// The engine's constructor needs a live DOM (wrapper element, ResizeObserver,
// a 2D context for text measurement, a renderer). Most of what is worth testing
// - the zone/date math, the allocation index, lane assignment, the virtual
// scroll mapping - touches none of that, so these helpers build an object on
// the engine's prototype carrying only the state those methods read.
//
// Anything that genuinely needs a DOM belongs in a browser-driven test instead.

import { TimelineEngine } from '../../../src/BlazorResourceTimeline/wwwroot/timeline-engine.js';

// Mirrors the defaults in the engine's constructor for the fields the
// DOM-independent methods touch. Kept explicit rather than reaching into a real
// instance so a test failure points at the behaviour, not at fixture drift.
export function makeBareEngine(overrides = {}) {
    const engine = Object.create(TimelineEngine.prototype);

    engine.config = {
        resourceHeight: 40,
        timeAxisHeight: 60,
        resourceAxisWidth: 150,
        resourceIndent: 16,
        dateRowHeight: 22,
        barHeight: 4,
        barMargin: 2,
        minBarWidth: 2,
        minBarWidthForLabels: 24,
        barLabelGap: 3,
        barIconSize: 16,
        hitTolerance: 3,
        timeZone: null,
        locale: null,
        pixelsPerHour: null,
        minPixelsPerHour: 0.25,
        maxPixelsPerHour: 1200,
        barLabelFont: '11px sans-serif',
        dateLabelFont: '12px sans-serif',
        hourLabelFont: '12px sans-serif',
        resourceLabelFont: '13px sans-serif',
        resourceGroupFont: 'bold 13px sans-serif',
        resourceChevronFont: '10px sans-serif',
        resourceChevronGap: 14,
        ...(overrides.config || {}),
        // Always present on the real config, and _applyOptions merges into it.
        colors: { bar: '#74c0fc', barSelected: '#4dabf7', label: '#495057' }
    };

    engine.allocations = [];
    engine.allocationsByResource = new Map();
    engine.resources = [];
    engine._rows = [];
    engine._childrenById = new Map();
    engine._resourceRoots = [];
    engine._collapsed = new Set();
    engine._rowIndexById = new Map();
    engine.selectedBars = new Set();
    engine.timeRange = { start: null, end: null };

    engine._laneInfo = new WeakMap();
    engine._barLayoutGen = 1;
    engine._configGen = 1;
    engine._configSnap = null;
    engine._configSnapGen = -1;
    engine._rowHeights = [];
    engine._rowTops = [0];

    engine.scrollX = 0;
    engine.scrollY = 0;
    engine._viewportW = 1200;
    engine._viewportH = 600;
    engine._visibleWidth = 1050;
    engine._pixelsPerMs = 0;
    engine._pixelsPerHour = 0;
    engine._userPixelsPerHour = null;
    engine._virtualWidth = 0;
    engine._virtualScrollMaxX = 0;
    engine._scrollScaleX = 1;

    // Reporting rows back to .NET is interop; there is no dotNetRef here.
    engine.dotNetRef = null;

    Object.assign(engine, overrides.engine || {});
    return engine;
}

// A bare engine with its ZonedTime built, for the axis helpers.
export function makeZonedEngine(timeZone, locale = null) {
    const engine = makeBareEngine({ config: { timeZone, locale } });
    engine._rebuildDateFormatters();
    return engine;
}

export { ZonedTime } from '../../../src/BlazorResourceTimeline/wwwroot/zoned-time.js';

// A bare engine holding the given allocations, indexed as the real one would.
// When resources are not supplied, one leaf row is synthesized per resourceId
// seen in the allocations so variable row-height metrics have something to size.
export function makeIndexedEngine(allocations, overrides = {}) {
    const engine = makeBareEngine(overrides);
    engine.allocations = allocations.slice().sort((a, b) => a.startTime - b.startTime);
    if (!engine._rows.length) {
        const seen = new Set();
        for (const a of engine.allocations) {
            if (!seen.has(a.resourceId)) {
                seen.add(a.resourceId);
                engine._rows.push({
                    resource: { id: a.resourceId, name: a.resourceId },
                    depth: 0,
                    hasChildren: false
                });
            }
        }
    }
    engine._indexAllocations();
    return engine;
}

// Deterministic PRNG so a failing case can be reproduced from its seed.
export function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

// Random allocations across `resources`, sorted by start time. Some carry edge
// bars and explicit heights, which feed the row bounds and lane heights.
export function genAllocations(rand, count, resources) {
    const out = [];
    for (let i = 0; i < count; i++) {
        const start = Math.floor(rand() * 1000000);
        const a = {
            id: 'a' + i,
            resourceId: resources[Math.floor(rand() * resources.length)],
            startTime: start,
            endTime: start + 1 + Math.floor(rand() * 50000)
        };
        if (rand() < 0.25) a.startBar = { duration: Math.floor(rand() * 20000) };
        if (rand() < 0.25) a.endBar = { duration: Math.floor(rand() * 20000) };
        if (rand() < 0.30) a.height = 2 + Math.floor(rand() * 20);
        out.push(a);
    }
    return out.sort((x, y) => x.startTime - y.startTime);
}

// Invariants the allocation index must satisfy at all times. Returns the list
// of violations (empty when healthy). These are absolute checks, not a
// comparison against another implementation, so they still catch a bug that
// happens to be present in both an incremental and a full rebuild.
export function indexViolations(engine) {
    const errs = [];
    let indexed = 0;

    for (const [resourceId, row] of engine.allocationsByResource) {
        indexed += row.items.length;
        let trueSpan = 0;
        let trueStartEdge = 0;

        for (let i = 0; i < row.items.length; i++) {
            const a = row.items[i];
            if (i > 0 && row.items[i - 1].startTime > a.startTime) {
                errs.push(`row ${resourceId}: items not sorted at index ${i}`);
            }
            if (a.resourceId !== resourceId) {
                errs.push(`row ${resourceId}: holds allocation of ${a.resourceId}`);
            }
            const se = a.startBar && a.startBar.duration > 0 ? a.startBar.duration : 0;
            const ee = a.endBar && a.endBar.duration > 0 ? a.endBar.duration : 0;
            trueSpan = Math.max(trueSpan, (a.endTime - a.startTime) + se + ee);
            trueStartEdge = Math.max(trueStartEdge, se);
        }

        // The bounds may be wider than necessary (they only widen on edit) but
        // must never be narrower, or scans would skip bars that are on screen.
        if (row.maxSpanMs < trueSpan) {
            errs.push(`row ${resourceId}: maxSpanMs ${row.maxSpanMs} < actual ${trueSpan}`);
        }
        if (row.maxStartEdgeMs < trueStartEdge) {
            errs.push(`row ${resourceId}: maxStartEdgeMs ${row.maxStartEdgeMs} < actual ${trueStartEdge}`);
        }
    }

    for (let i = 1; i < engine.allocations.length; i++) {
        if (engine.allocations[i - 1].startTime > engine.allocations[i].startTime) {
            errs.push(`global allocation list not sorted at index ${i}`);
            break;
        }
    }
    if (indexed !== engine.allocations.length) {
        errs.push(`index holds ${indexed} allocations, global list has ${engine.allocations.length}`);
    }
    const ids = new Set(engine.allocations.map(a => a.id));
    if (ids.size !== engine.allocations.length) {
        errs.push('duplicate allocation ids in global list');
    }
    return errs;
}

// Comparable view of the index: order, lanes and resolved stacking offsets.
// Cluster objects differ by reference between engines, so they are compared
// structurally.
export function indexSnapshot(engine) {
    return [...engine.allocationsByResource]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([resourceId, row]) => ({
            resourceId,
            order: row.items.map(a => a.id),
            lanes: row.items.map(a => engine._laneInfo.get(a).lane),
            laneHeights: row.items.map(a => engine._laneInfo.get(a).cluster.laneHeights.join(',')),
            offsets: row.items.map(a => engine._stackOffset(a))
        }));
}
