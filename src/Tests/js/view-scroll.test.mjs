// Where the viewport lands across data loads: the first-load centering on
// "now" (autoScrollToNow), keeping the view across a reload
// (preserveScrollOnReload), and the "now" indicator's refresh timer.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeBareEngine } from './helpers/engine-fixture.mjs';

const HOUR = 3600000;

// Applies a horizontal scale (pixels per hour) and the derived scroll extent,
// as _relayout does once the wrapper has a size.
function applyScale(engine, pixelsPerHour) {
    const c = engine.config;
    engine._pixelsPerHour = pixelsPerHour;
    engine._pixelsPerMs = pixelsPerHour / HOUR;
    engine._visibleWidth = engine._viewportW - c.resourceAxisWidth;
    const virtualWidth =
        c.resourceAxisWidth + (engine.timeRange.end - engine.timeRange.start) * engine._pixelsPerMs;
    engine._virtualScrollMaxX = Math.max(0, virtualWidth - engine._viewportW);
}

// A laid-out engine over a three-day range centered on the current time, at
// 60px/hour, with enough minimum-height rows to overflow the fixture's
// viewport (so the vertical position is not simply clamped to zero).
function makeLaidOutEngine(overrides = {}) {
    const engine = makeBareEngine(overrides);
    const now = Date.now();
    engine.timeRange = { start: now - 36 * HOUR, end: now + 36 * HOUR };
    setRows(engine, rowIds(20));
    applyScale(engine, 60);
    return engine;
}

function rowIds(count, prefix = 'r') {
    return Array.from({ length: count }, (_, i) => prefix + i);
}

function setRows(engine, ids) {
    engine._rows = ids.map(id => ({ resource: { id, name: id }, depth: 0, hasChildren: false }));
    engine._rowIndexById = new Map(ids.map((id, i) => [id, i]));
    engine._recomputeRowMetrics();
}

// Screen x of the horizontal center of the content area (where "now" belongs
// after an auto-scroll), and the screen x the "now" line actually sits at.
function contentCenterX(engine) {
    return engine.config.resourceAxisWidth + engine._visibleWidth / 2;
}

test('the first load centers "now" in the content area when autoScrollToNow is set', () => {
    const engine = makeLaidOutEngine({ config: { autoScrollToNow: true } });

    engine._prepareLoadScroll();
    engine._applyPendingScroll();

    assert.ok(
        Math.abs(engine.getTimeToX(Date.now()) - contentCenterX(engine)) < 1,
        'the now line must end up at the center of the content area');
});

test('the first load leaves the view alone without autoScrollToNow', () => {
    const engine = makeLaidOutEngine();

    engine._prepareLoadScroll();
    engine._applyPendingScroll();

    assert.equal(engine.scrollX, 0);
});

test('only the first load centers on "now"', () => {
    const engine = makeLaidOutEngine({ config: { autoScrollToNow: true } });
    engine._prepareLoadScroll();
    engine._applyPendingScroll();

    // The user scrolls elsewhere, then the host reloads its data.
    engine._setVirtualScrollX(0);
    engine._prepareLoadScroll();
    engine._applyPendingScroll();

    assert.equal(engine.scrollX, 0, 'a later load must not pull the view back to now');
});

test('a reload keeps the leading time in view despite a changed range and scale', () => {
    const engine = makeLaidOutEngine({ config: { preserveScrollOnReload: true } });
    engine._firstLoadDone = true;
    engine._setVirtualScrollX(1000);
    const leadTime = engine.getXToTime(engine.config.resourceAxisWidth);

    engine._prepareLoadScroll();
    // The reload widens the range in both directions and zooms out.
    engine.timeRange = {
        start: engine.timeRange.start - 24 * HOUR,
        end: engine.timeRange.end + 24 * HOUR
    };
    applyScale(engine, 30);
    engine._applyPendingScroll();

    assert.ok(
        Math.abs(engine.getXToTime(engine.config.resourceAxisWidth) - leadTime) < 1000,
        'the same time must still sit at the left edge of the content area');
});

test('a reload keeps the top row in view when the rows above it change', () => {
    const engine = makeLaidOutEngine({ config: { preserveScrollOnReload: true } });
    engine._firstLoadDone = true;
    engine._setScrollY(engine._rowContentTop(4));
    assert.ok(engine.scrollY > 0, 'the fixture must actually be scrolled vertically');

    engine._prepareLoadScroll();
    // A row is inserted ahead of the anchored one, moving it further down.
    setRows(engine, ['new', ...rowIds(20)]);
    engine._applyPendingScroll();

    assert.equal(engine._rowIndexAtContentY(engine.scrollY), 5, 'r4 must still be the top row');
});

test('a reload that drops the anchored row keeps the vertical offset', () => {
    const engine = makeLaidOutEngine({ config: { preserveScrollOnReload: true } });
    engine._firstLoadDone = true;
    engine._setScrollY(engine._rowContentTop(4));
    const scrollY = engine.scrollY;

    engine._prepareLoadScroll();
    setRows(engine, rowIds(20, 'x'));
    engine._applyPendingScroll();

    assert.equal(engine.scrollY, scrollY);
});

test('a reload without the flag does not queue anything', () => {
    const engine = makeLaidOutEngine();
    engine._firstLoadDone = true;
    engine._setVirtualScrollX(1000);

    engine._prepareLoadScroll();

    assert.equal(engine._pendingScroll, null);
});

test('centering is skipped when "now" falls outside the loaded range', () => {
    const engine = makeLaidOutEngine({ config: { autoScrollToNow: true } });
    engine.timeRange = { start: Date.now() - 72 * HOUR, end: Date.now() - 48 * HOUR };
    applyScale(engine, 60);

    engine._prepareLoadScroll();
    engine._applyPendingScroll();

    assert.equal(engine.scrollX, 0);
});

test('a streamed load restores the view once the batches have landed', () => {
    const engine = makeLaidOutEngine({ config: { preserveScrollOnReload: true } });
    engine._firstLoadDone = true;
    engine._setVirtualScrollX(1000);
    const leadTime = engine.getXToTime(engine.config.resourceAxisWidth);

    // beginData queues the view and hands it to endData, because the rows only
    // reach their final heights once the batches have been indexed.
    engine._prepareLoadScroll();
    engine._streamScroll = engine._pendingScroll;
    engine._applyPendingScroll();
    engine._setVirtualScrollX(0);

    engine._pendingScroll = engine._streamScroll;
    engine._streamScroll = null;
    engine._applyPendingScroll();

    assert.ok(Math.abs(engine.getXToTime(engine.config.resourceAxisWidth) - leadTime) < 1);
});

test('the "now" indicator timer is off when its interval is zero', () => {
    const engine = makeLaidOutEngine({ config: { nowLineRefreshMs: 0 } });
    engine._nowTimer = null;

    engine._startNowTimer();

    assert.equal(engine._nowTimer, null);
});

test('the "now" indicator repaints on its interval, but only when it would move', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const engine = makeLaidOutEngine({ config: { nowLineRefreshMs: 1000 } });
    let renders = 0;
    engine.render = () => { renders++; };
    engine._lastNowX = NaN;
    engine._nowTimer = null;

    engine._startNowTimer();
    try {
        t.mock.timers.tick(1000);
        assert.equal(renders, 1, 'the first tick moves the line off its unknown position');

        // The wall clock has not really advanced, so the line would land on the
        // same pixel and the frame would be identical.
        t.mock.timers.tick(1000);
        assert.equal(renders, 1, 'a tick that would not move the line must not repaint');
    } finally {
        engine._stopNowTimer();
    }
});
