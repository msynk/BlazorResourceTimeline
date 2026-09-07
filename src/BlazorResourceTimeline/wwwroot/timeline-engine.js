// Rendering-agnostic engine for the BlazorResourceTimeline component.
//
// The engine owns all timeline behavior - data and hierarchy indexing,
// scroll/zoom and virtual-scroll math, pointer/keyboard interaction,
// hit-testing, selection, editing, tooltips, on-demand (windowed) loading and
// the .NET interop surface. What it does NOT do is paint: every frame it
// builds a viewport-culled scene (a plain display list, see buildScene) and
// hands it to a pluggable renderer (canvas, SVG or HTML - see ./renderers).
//
// The renderer contract:
//   surface            root element; the engine binds pointer/wheel events to
//                      it and drives its cursor. Created inside the wrapper.
//   resize(cssW, cssH) the viewport size changed; size the surface to match.
//   render(scene)      paint one frame from the scene.
//   dispose()          remove the surface and release resources.
// Renderers receive a host object ({ requestRender, getImage }) for async
// needs such as icon images finishing loading.

import { ZonedTime, utcHourBoundaries } from './zoned-time.js';
import { Tooltip } from './tooltip.js';

// Consecutive render failures logged before the engine goes quiet about them.
const MAX_RENDER_ERROR_LOGS = 3;

// Hidden bars listed individually in a +N marker's tooltip before the rest are
// summarized as a count.
const MAX_OVERFLOW_TOOLTIP_BARS = 8;

// Upper bound on cached bar-icon images. Icons are drawn from a small, stable
// set in practice; the cap only matters for hosts that mint per-bar image URLs,
// where an unbounded cache would grow without limit.
const MAX_IMAGE_CACHE = 256;

// Window in which a second still click is treated as a double-click. Matches
// the typical OS default; distance uses config.dragThreshold.
const DBLCLICK_MS = 500;

// Shared empty row index, returned for resources with no allocations so hot
// scan paths never have to null-check. Never mutated.
const EMPTY_ROW_INDEX = Object.freeze({
    items: Object.freeze([]), maxStartEdgeMs: 0, maxSpanMs: 0
});

// Lane clearance used when stackLabelClearance is off: stacked bars then sit
// barMargin apart, as they always did.
const NO_CLEARANCE = Object.freeze({ above: 0, below: 0 });

// Painted span used when stackOnLabelCollision is off: bars then claim their own
// time span only, so nothing but a real time overlap stacks them.
const NO_SPAN = Object.freeze({ lead: 0, trail: 0 });

// Line box a bar label occupies, as a multiple of its font's pixel size, and
// the size assumed when barLabelFont carries no px size to read.
const LABEL_LINE_HEIGHT_RATIO = 1.2;
const DEFAULT_LABEL_FONT_SIZE = 11;

export class TimelineEngine {
    constructor(wrapper, dotNetRef, options, rendererRegistry) {
        // The wrapper (scroll viewport) element is passed directly from Blazor
        // as an ElementReference; the renderer creates its surface inside it.
        this.wrapper = wrapper;
        this.dotNetRef = dotNetRef || null;
        this._rendererRegistry = rendererRegistry || {};

        // Visual configuration. Defaults below; overridable via the options
        // argument (and later setOptions). Keys match the camelCased property
        // names of the .NET options model.
        this.config = {
            // Minimum resource-row height. Grows per row when overlapping bars
            // stack taller, preserving the same top/bottom padding a single
            // default-height bar has in a minimum-height row.
            resourceHeight: 40,
            timeAxisHeight: 60,
            resourceAxisWidth: 150,
            // Horizontal indent (px) applied per hierarchy depth level to the
            // resource-axis labels, plus room for the group expand/collapse
            // chevron on parent rows.
            resourceIndent: 16,
            dateRowHeight: 22,
            barHeight: 4,
            // Vertical gap (px) between bars that overlap in time on the same
            // row. Overlapping bars are stacked apart around the row's center
            // line instead of drawn on top of each other; this is the distance
            // between them (0 stacks them touching). Rows grow as needed so
            // the stack keeps the same top/bottom padding as a single bar.
            barMargin: 2,
            // Widens the gap between stacked bars by the vertical room each
            // one's labels and icons need, so a stacked bar's text is not drawn
            // over its neighbour (barMargin alone only keeps the bars apart,
            // which for the default 4px bar leaves labels overlapping). Rows
            // grow to fit. The reserved room is deliberately independent of
            // zoom - decorations themselves are dropped below
            // minBarWidthForLabels - so rows do not reflow while zooming.
            stackLabelClearance: true,
            // Stacks bars whose *painted* spans collide, not only those whose
            // times overlap: two bars minutes apart still draw their labels,
            // icons and delay bars into the gap between them, and one lane
            // cannot hold both legibly. What collides depends on the zoom, so
            // lane membership - and with it row height - is recomputed when the
            // scale changes. Bars too narrow for decorations (see
            // minBarWidthForLabels) claim nothing extra, which is what stops a
            // zoomed-out row from stacking every bar in it.
            stackOnLabelCollision: true,
            minBarWidth: 2,
            // Decorations are skipped when the main bar's drawn width falls
            // below this threshold, keeping dense timelines readable.
            minBarWidthForLabels: 24,
            barLabelFont: '11px sans-serif',
            barLabelGap: 3,
            barIconSize: 16,
            // Axis typography. These are read by every renderer *and* by the
            // engine when it measures a day label to pin it, so they have to
            // live in one place - a renderer drawing at a different size than
            // the engine measured would mis-pin the label.
            dateLabelFont: '12px sans-serif',
            hourLabelFont: '12px sans-serif',
            resourceLabelFont: '13px sans-serif',
            resourceGroupFont: 'bold 13px sans-serif',
            resourceChevronFont: '10px sans-serif',
            // Gap between a group row's chevron and its label, in pixels.
            resourceChevronGap: 14,
            colors: {
                contentBg: '#ffffff',
                axisBg: '#f8f9fa',
                axisBorder: '#dee2e6',
                tick: '#adb5bd',
                label: '#495057',
                dateLabel: '#212529',
                grid: '#e9ecef',
                bar: '#74c0fc',
                barSelected: '#4dabf7',
                barSelectedBorder: '#1971c2',
                barLabel: '#495057',
                now: '#e03131',
                selectionFill: 'rgba(77, 171, 247, 0.18)',
                selectionBorder: '#4dabf7',
                // Keyboard focus ring drawn around the focused bar.
                focus: '#1971c2',
                // Hover tooltip background/text.
                tooltipBg: '#212529',
                tooltipText: '#ffffff',
                nonWorking: 'rgba(0, 0, 0, 0.06)'
            },
            // Minimum pointer movement (px) before a press is treated as a
            // rubber-band drag rather than a click.
            dragThreshold: 4,
            // Extra pixels around a bar's drawn extent that still count as a
            // hit, so very short bars remain comfortably clickable.
            hitTolerance: 3,
            // IANA time zone id (e.g. "UTC", "Europe/Berlin") the axis is drawn
            // in: day/hour boundaries and labels are computed in this zone.
            // null uses the viewer's local zone.
            timeZone: null,
            // BCP 47 locale (e.g. "de-DE") for day labels, tooltips and
            // screen-reader announcements. null uses the viewer's locale.
            locale: null,
            // First day of the week: 0=Sunday … 6=Saturday. null = locale
            // weekInfo (else Monday). Used if week banding is added later.
            firstDayOfWeek: null,
            // Hour-row labels as 12-hour clock (e.g. "3 PM"). Tick positions
            // stay on whole hours. Default is 00–23.
            hour12: false,
            // Weekdays shaded as non-working (0=Sun … 6=Sat). Empty = none.
            nonWorkingDays: [],
            // Working-hours window as minutes from local midnight. null = no
            // off-hour bands. Visual only.
            workingHoursStart: null,
            workingHoursEnd: null,
            // Max stacking lanes per cluster. 0 = unlimited. Extra bars are
            // hidden and a +N label is drawn at the cluster's trailing edge.
            maxStackLanes: 0,
            // Adds a second hour row to the time axis, in UTC, above the row
            // drawn in `timeZone` and below the day labels. It is an
            // independent hour row - its own boundaries, ticks and whole-hour
            // labels - so its numbers sit horizontally offset from the zone
            // row's by any minutes in that zone's UTC offset. The band below
            // the date row is split between the two rows, so timeAxisHeight is
            // what gives them room.
            showUtcTime: false,
            // Horizontal scale in pixels per hour. null means auto: fit exactly
            // one day into the viewport width (the original behavior). An
            // explicit value (or runtime zoom) is clamped to the min/max below.
            pixelsPerHour: null,
            minPixelsPerHour: 0.25,
            maxPixelsPerHour: 1200,
            // Centers the current time in the view on the first data load, so
            // a timeline meant to open "at now" needs no goToNow() call from
            // the host. Only the first load: every later one leaves the
            // viewport alone (see preserveScrollOnReload).
            autoScrollToNow: false,
            // Keeps a reload showing what it was showing - the time at the
            // left edge of the content area and the row at the top - instead
            // of letting a changed range, scale or row list move the view.
            preserveScrollOnReload: false,
            // How often (ms) the "now" indicator is repainted so it keeps up
            // with the wall clock on an idle timeline. 0 stops the ticking.
            nowLineRefreshMs: 60 * 1000,
            // When true, panByDays lands the leading edge on a local midnight
            // (the start of the day `days` calendar days away in `timeZone`)
            // instead of shifting by exactly 24 hours. DST 23/25-hour days
            // are a single step. Default keeps the 24-hour behaviour. A
            // non-null second argument to panByDays wins over this for that
            // call.
            panToDayStart: false,
            // Editing. When editable, a bar can be dragged to move it in time
            // (and, if allowResourceChange, onto another resource row), or
            // grabbed near an edge to resize its start/end. Moves/resizes snap
            // to editSnapMinutes (0 = continuous) and never shrink below
            // editMinDurationMinutes. editResizeHandlePx is the grab zone at
            // each end of the main bar.
            editable: false,
            editSnapMinutes: 15,
            // When true (default), snap to wall-clock multiples of
            // editSnapMinutes from local midnight in timeZone. false keeps
            // the Unix-epoch grid.
            snapToTimeZone: true,
            editResizeHandlePx: 6,
            editMinDurationMinutes: 5,
            allowResourceChange: true,
            // When false, a move/resize that would overlap another unlocked bar
            // on the same resource is refused (touching ends still allowed).
            allowOverlap: true,
            // Empty-content drag: 'marquee' (default) or 'create' (needs Editable
            // and a host OnAllocationCreating handler). Ctrl/Cmd still marquees.
            emptyDragAction: 'marquee',
            // Delete/Backspace removes selected (or focused) bars after the host
            // confirms. Off by default so a stray keypress cannot drop data.
            allowDelete: false,
            // Hover tooltips. When enabled, hovering a bar (mouse/pen) shows a
            // small popup after tooltipDelayMs. The text is the allocation's
            // `tooltip` field, or a default built from its labels/time range.
            showTooltips: true,
            tooltipDelayMs: 300,
            // When true, hover reports to .NET for a Blazor TooltipTemplate
            // overlay instead of the built-in text tooltip.
            tooltipTemplate: false,
            // On-demand (windowed) data loading. In windowed mode the host
            // serves only the allocations for the requested time window; the
            // engine fetches a window buffered by windowBufferFactor viewports
            // on each side, and refetches once scrolling/zoom brings the visible
            // range within windowRefetchThreshold viewports of the loaded edge.
            // windowDebounceMs coalesces scroll-driven requests.
            windowBufferFactor: 1,
            windowRefetchThreshold: 0.25,
            windowDebounceMs: 150,
            // When the host supplies an HTML resource-column template, the
            // renderer stops drawing the resource labels/chevrons (an HTML
            // overlay renders them instead) and the engine reports its visible
            // rows to .NET.
            resourceTemplate: false,
            // Drag (or keyboard) the divider at the right edge of the resource
            // column to change its width. Off restores a fixed column.
            resourceAxisResizable: true,
            // Clamp for an interactive (or programmatic) resource-column resize.
            // The viewport still keeps at least 100px of content area, so a
            // configured max wider than that is reduced to fit.
            resourceAxisMinWidth: 80,
            resourceAxisMaxWidth: 0,
            // Which renderer paints the scene: 'canvas' (default), 'svg' or
            // 'html'. Can be switched at runtime via setOptions.
            renderer: 'canvas'
        };

        // Bumped on every config change, invalidating the frozen scene config
        // snapshot (see _configSnapshot). Initialized before the first
        // _applyOptions call, which bumps it.
        this._configGen = 0;
        this._configSnap = null;
        this._configSnapGen = -1;

        // Apply caller overrides before anything derived from config is read,
        // then build the (zone-aware) date/time formatters used by the axis.
        this._applyOptions(options);
        this._rebuildDateFormatters();

        // Data
        this.resources = [];
        // Resource hierarchy, derived from `resources` (parentId links). `_rows`
        // is the flat, ordered list of currently *visible* rows (collapsed groups
        // hide their descendants) and is what every layout/hit-test path indexes
        // into instead of `resources` directly. See _rebuildResourceStructure.
        this._rows = [];
        this._childrenById = new Map();   // resourceId -> child resources
        this._resourceRoots = [];         // top-level resources, in input order
        this._collapsed = new Set();      // ids of collapsed group resources
        this._rowIndexById = new Map();   // resourceId -> index into _rows
        this.timeRange = { start: null, end: null };
        this.allocations = [];
        // Persistent index: resourceId -> row index, where a row index is
        // { items, maxStartEdgeMs, maxSpanMs } - the row's allocations sorted
        // by startTime plus the bounds its scans need. See _indexAllocations,
        // and _firstVisibleAllocationIndex for how the bounds are used.
        this.allocationsByResource = new Map();

        // Stacking lane per allocation, as { cluster, lane }. Held in a side
        // table rather than written onto the allocation objects themselves:
        // those come from the host over interop and are not ours to decorate.
        // Weak, so entries disappear with the allocations they describe.
        this._laneInfo = new WeakMap();

        // Cache of loaded <img> elements keyed by source, used to lay out and
        // draw bar icons. Images load asynchronously; a re-render is triggered
        // once each one is ready. Owned by the engine (not the renderer)
        // because decoration layout needs the natural aspect ratio.
        this.imageCache = new Map();

        // State
        // Ids of the selected bars, in the order they were selected (Set
        // preserves insertion order). Ids rather than allocation objects: only
        // membership is ever needed, and holding objects meant a windowed
        // refetch left stale instances behind.
        this.selectedBars = new Set();
        this.scrollX = 0;
        this.scrollY = 0;

        // Rubber-band (marquee) drag state. Coordinates are stored in content
        // space (independent of scroll) so the rectangle tracks the data while
        // the user scrolls mid-drag. Only mouse and pen pointers start a drag;
        // touch is reserved for native scrolling (see _touch below).
        this.drag = null;
        // Set when the marquee rectangle has changed and the selection it
        // implies has not been recomputed yet; consumed by the paint frame.
        this._marqueeDirty = false;

        // In-progress edit (move/resize) of a single allocation via mouse/pen.
        // null when idle. Holds the original and previewed start/end/resource so
        // the change can be drawn as a ghost and committed (or discarded) on
        // pointer up. See handlePointerDown/Move/Up and _buildGhostScene.
        this.edit = null;

        // Hover tooltip, created on first hover (see _ensureTooltip). Owns its
        // own element, timer and positioning - see ./tooltip.js.
        this._tooltip = null;

        // On-demand (windowed) loading state. When _windowed, allocations are
        // fetched per time window from .NET rather than supplied all at once.
        // _loadedStart/_loadedEnd bound the currently loaded window; the ids and
        // pending flags drop stale responses and avoid duplicate requests.
        this._windowed = false;
        this._loadedStart = 0;
        this._loadedEnd = 0;
        this._windowRequestId = 0;
        this._windowAppliedId = -1;
        this._windowPending = false;
        this._pendingStart = 0;
        this._pendingEnd = 0;
        this._windowCheckTimer = null;

        // HTML resource-column overlay inner element (set via
        // enableResourceTemplate); translated to follow vertical scroll.
        this._resourceOverlay = null;

        // DOM handle on the resource-axis divider (created lazily). Pointer
        // capture lives on it so a drag keeps tracking outside the column,
        // including when the HTML resource overlay is covering the surface.
        this._axisSplitter = null;
        this._axisResize = null;

        // Pending touch interaction. Touch does not start a marquee (so the
        // wrapper can still be panned); a quick, stationary touch is treated as
        // a tap-to-select on release instead.
        this._touch = null;

        // Click / double-click reporting. _press is the surface point of the
        // current pointerdown (cleared on up/cancel). _suppressClick skips the
        // click event after a marquee, edit or pan. _lastClick times successive
        // still presses so the second raises OnDoubleClick as well as OnClick.
        this._press = null;
        this._suppressClick = false;
        this._lastClick = null;

        // Keyboard focus (accessibility). _focusResource is the index of the
        // resource row the keyboard cursor is on; _focusAlloc is the allocation
        // within it that has the roving focus (or null on an empty row).
        // _hasFocus tracks whether the wrapper actually holds DOM focus so the
        // focus ring is only painted while keyboard interaction is possible.
        this._focusResource = -1;
        this._focusAlloc = null;
        this._hasFocus = false;

        // Accumulator for the streaming (chunked) data load; null when no
        // batched load is in progress. See beginData/appendAllocations/endData.
        this._loadBuffer = null;
        this._loadExpected = 0;

        // Bumped whenever barHeight/barMargin change, invalidating the cached
        // per-cluster stacking offsets (see _stackOffset).
        this._barLayoutGen = 1;

        // Bumped whenever an option the decoration measurements are taken from
        // changes, invalidating the caches below. Per-allocation boxes are held
        // weakly (host objects, not ours to decorate) and are dropped wholesale
        // on re-index, since a host may reuse the same objects with new labels.
        this._decorGen = 1;
        this._decorBoxes = new WeakMap();
        this._labelMetricsCache = null;
        this._labelWidths = null;
        this._labelWidthsGen = 0;
        // Reused by the lane pass so measuring a painted span allocates nothing.
        this._spanScratch = { lead: 0, trail: 0 };
        // Horizontal scale the current lane assignment was built for. Lanes
        // depend on it once decorations count towards overlap; null means they
        // have not been assigned yet. See _syncLanesToScale.
        this._laneScale = null;

        // Per-visible-row layout for variable-height virtualization.
        // _rowTops[i] is the content-space Y of row i's top; _rowTops[n] is the
        // total height of all rows. Rebuilt by _recomputeRowMetrics whenever
        // lanes, bar layout options, or the visible row list change.
        this._rowHeights = [];
        this._rowTops = [0];

        this._lastView = null;
        this._warnedAllocIds = new Set();
        this._resourceIdSet = new Set();
        this._selectionAnchorId = null;
        this._copyClipboard = [];
        this._overflowHits = [];
        this._lastHoverId = undefined;

        // Last x the "now" indicator was painted at, so the once-a-minute tick
        // can skip repaints that would not move it (see _nowTimer).
        this._lastNowX = NaN;

        // Performance helpers
        this.visibleTimeRange = null;
        this.animationFrame = null;
        this._scrollRaf = null;

        // Cached viewport metrics, maintained by the ResizeObserver so the
        // render path never calls getBoundingClientRect (which can force
        // synchronous layout) inside hot loops.
        //
        // The surface's viewport rect is cached for the same reason: pointer
        // coordinates are mapped through it, and pointermove fires at >120Hz on
        // modern trackpads. It is invalidated whenever anything could have moved
        // the surface (resize, any ancestor scroll, renderer swap) and re-read at
        // the start of each gesture, so a stale rect can never affect a click.
        this._surfaceRect = null;
        this._viewportW = 0;   // wrapper width in CSS pixels
        this._viewportH = 0;   // wrapper height in CSS pixels
        this._visibleWidth = 0; // viewport width minus the resource axis
        this._pixelsPerMs = 0;  // horizontal scale (derived from pixelsPerHour)
        this._pixelsPerHour = 0; // effective horizontal scale after clamping
        // Runtime zoom override (pixels per hour) set via the zoom API; null
        // defers to config.pixelsPerHour, and then to auto (one day per view).
        this._userPixelsPerHour = null;

        // Logical (virtual) horizontal scrolling. The full content can be wider
        // than a DOM element is allowed to be (browsers clamp at ~16.7M px), so
        // the scroll spacer is capped and the native scrollLeft is mapped onto a
        // larger virtual space. scrollX below is always the *virtual* horizontal
        // offset (in content pixels); _scrollScaleX is virtual-per-real, and is
        // 1 whenever the content fits within the cap (the common case).
        // Scroll spacer element and the dimensions last written to it, so
        // _relayout can skip redundant style writes.
        this._contentDiv = null;
        this._spacerW = -1;
        this._spacerH = -1;

        this._virtualWidth = 0;     // full content width in px (uncapped)
        this._virtualScrollMaxX = 0; // max virtual scrollX (virtualWidth - viewport)
        this._scrollScaleX = 1;     // virtual px per real (spacer) px, >= 1

        // Whether any data has been loaded yet. The first load is the special
        // one: autoScrollToNow centers it on the current time, and there is no
        // earlier view for preserveScrollOnReload to put back.
        this._firstLoadDone = false;

        // Where the viewport should end up once the next layout runs - the view
        // captured before a reload, or the initial centering on "now". Applied
        // by _relayout, the first point at which the new scale and scroll
        // extent are known (and which defers it while the wrapper has no size).
        this._pendingScroll = null;
        // The same, held across a streaming load so endData can restore the
        // view again once the bars have settled the row heights.
        this._streamScroll = null;

        // Hidden 2D context used only for text measurement (date-label
        // pinning). Rendering-agnostic: available regardless of the active
        // renderer, and never attached to the document.
        this._measureCtx = document.createElement('canvas').getContext('2d');

        // Seed the viewport size so data arriving before the first
        // ResizeObserver delivery can still be laid out.
        const wrapperRect = this.wrapper.getBoundingClientRect();
        this._viewportW = wrapperRect.width;
        this._viewportH = wrapperRect.height;

        // Resolvers waiting for the next completed paint (see whenRendered).
        this._renderedResolvers = [];
        this._renderPending = false;

        // Bound handlers so we can remove them on dispose
        this._onResize = () => { this._surfaceRect = null; this._relayout(); };
        this._onScroll = () => this._handleScroll();
        // Capture phase so scrolling in *any* ancestor is seen (scroll events
        // do not bubble). Only drops the cached rect; no layout is read here.
        this._onAnyScroll = () => { this._surfaceRect = null; };
        this._onPointerDown = (e) => this.handlePointerDown(e);
        this._onPointerMove = (e) => this.handlePointerMove(e);
        this._onPointerUp = (e) => this.handlePointerUp(e);
        this._onPointerCancel = (e) => this.handlePointerCancel(e);
        this._onPointerLeave = () => { this._hideTooltip(); this._setCursor(''); };
        // Entering the surface starts a fresh gesture: re-read the rect once so
        // the whole hover/drag that follows maps through an accurate cache.
        this._onPointerEnter = () => { this._surfaceRect = null; };
        this._onWheel = (e) => this.handleWheel(e);
        this._onContextMenu = (e) => this.handleContextMenu(e);
        this._onKeyDown = (e) => this.handleKeyDown(e);
        this._onFocusIn = () => { this._hasFocus = true; this.render(); };
        this._onFocusOut = () => { this._hasFocus = false; this.render(); };

        // The renderer must exist before surface events are bound.
        this.renderer = null;
        this._createRenderer(this.config.renderer);

        // Visually hidden live region: keyboard navigation and selection are
        // announced here so screen-reader users get feedback from the surface
        // (which is otherwise opaque to assistive technology).
        this._createLiveRegion();

        this._setupEventListeners();
        this._syncAxisSplitterChrome();

        this._nowTimer = null;
        this._startNowTimer();
    }

    // Keeps the "now" indicator honest on idle timelines (e.g. a wall display
    // nobody scrolls): re-renders every nowLineRefreshMs while the current time
    // falls within the data range. A full redraw is a few milliseconds, which
    // the skips below keep to the ticks that would actually move the line.
    _startNowTimer() {
        const interval = this.config.nowLineRefreshMs;
        if (!(interval > 0)) return;

        this._nowTimer = setInterval(() => {
            if (!this._hasTimeRange()) return;
            // Nothing is presented while the tab is hidden; the next tick after
            // it becomes visible repaints with the correct time anyway.
            if (typeof document !== 'undefined' && document.hidden) return;
            const now = Date.now();
            if (now < this.timeRange.start || now > this.timeRange.end) return;
            // Only repaint when the indicator would actually land on a different
            // pixel. Zoomed out far enough, a whole interval's worth of time is
            // well under one pixel and the frame would be identical.
            const x = Math.round(this.getTimeToX(now));
            if (x === this._lastNowX) return;
            this._lastNowX = x;
            this.render();
        }, interval);
    }

    _stopNowTimer() {
        if (this._nowTimer) {
            clearInterval(this._nowTimer);
            this._nowTimer = null;
        }
    }

    // ---- Renderer management ----

    // Instantiates the renderer registered under the given name (falling back
    // to canvas) and hands it the host callbacks it may need asynchronously.
    _createRenderer(name) {
        const key = String(name || 'canvas').toLowerCase();
        const Renderer = this._rendererRegistry[key] || this._rendererRegistry.canvas;
        if (!Renderer) {
            throw new Error(`BlazorResourceTimeline: no renderer registered for '${key}'`);
        }
        const renderer = new Renderer(this.wrapper, {
            // Icon images finish loading after the frame that laid them out.
            requestRender: () => { if (this._hasTimeRange()) this.render(); },
            // Used after a canvas backing-store resize, which clears the bitmap
            // synchronously; painting in the same turn avoids a blank flash.
            paintNow: () => { if (this._hasTimeRange()) this._paintNow(); },
            getImage: (src) => this._getImage(src)
        });

        // Validate the contract up front. Without this, a renderer missing a
        // method fails much later, mid-frame, with an error that points at the
        // engine rather than at the renderer that is actually incomplete.
        for (const method of ['resize', 'render', 'dispose']) {
            if (typeof renderer[method] !== 'function') {
                throw new TypeError(
                    `BlazorResourceTimeline: renderer '${key}' does not implement ${method}().`);
            }
        }
        if (!renderer.surface || typeof renderer.surface.addEventListener !== 'function') {
            throw new TypeError(
                `BlazorResourceTimeline: renderer '${key}' did not expose a DOM element as 'surface'.`);
        }

        this.renderer = renderer;
    }

    // Swaps the active renderer at runtime (setOptions with a new renderer
    // name): the old surface and its event bindings are torn down, the new
    // renderer takes over, and the next layout pass repaints the same scene.
    _swapRenderer(name) {
        this._unbindSurfaceEvents();
        this.renderer.dispose();
        this._createRenderer(name);
        this._bindSurfaceEvents();
        // The cached rect belonged to the old surface element.
        this._surfaceRect = null;
    }

    _setCursor(cursor) {
        const surface = this.renderer && this.renderer.surface;
        if (surface && surface.style.cursor !== cursor) surface.style.cursor = cursor;
    }

    // Shallow-merges caller-provided visual options into the config, ignoring
    // null/undefined values (so a partial options object only overrides the
    // keys it sets). Colors are merged one level deeper. Keys are expected to
    // already be camelCased (Blazor's JSON interop does this for .NET models).
    _applyOptions(options) {
        // Bump unconditionally: callers treat this as "the config may have
        // changed", and the snapshot is cheap to rebuild once.
        this._configGen++;
        if (!options) return;
        const c = this.config;
        for (const key of Object.keys(options)) {
            if (key === 'colors') continue;
            const value = options[key];
            if (value === null || value === undefined) continue;
            // Only keys the default config declares are accepted. An unknown key
            // is a typo or a stale option name: silently writing it onto the
            // config would do nothing visible and be near-impossible to spot.
            if (!Object.prototype.hasOwnProperty.call(c, key)) {
                console.warn(`BlazorResourceTimeline: ignoring unknown option '${key}'`);
                continue;
            }
            c[key] = value;
        }
        if (options.colors) {
            for (const key of Object.keys(options.colors)) {
                const value = options.colors[key];
                if (value === null || value === undefined) continue;
                if (!Object.prototype.hasOwnProperty.call(c.colors, key)) {
                    console.warn(`BlazorResourceTimeline: ignoring unknown color '${key}'`);
                    continue;
                }
                c.colors[key] = value;
            }
        }
    }

    _setupEventListeners() {
        window.addEventListener('resize', this._onResize);
        window.addEventListener('scroll', this._onAnyScroll, { passive: true, capture: true });
        this.wrapper.addEventListener('scroll', this._onScroll, { passive: true });
        this._bindSurfaceEvents();
        // Keyboard interaction is bound to the focusable wrapper (role
        // "application"), not the surface, which cannot take focus itself.
        this.wrapper.addEventListener('keydown', this._onKeyDown);
        this.wrapper.addEventListener('focus', this._onFocusIn);
        this.wrapper.addEventListener('blur', this._onFocusOut);
        this._setupResizeObserver();
    }

    // Pointer events unify mouse, pen and touch. A mouse/pen drag captures
    // the pointer on the surface, so move/up keep tracking even when it
    // leaves the surface and the drag completes on release anywhere. Bound to
    // the renderer's surface (and re-bound when the renderer is swapped).
    _bindSurfaceEvents() {
        const s = this.renderer.surface;
        s.addEventListener('pointerdown', this._onPointerDown);
        s.addEventListener('pointermove', this._onPointerMove);
        s.addEventListener('pointerup', this._onPointerUp);
        s.addEventListener('pointercancel', this._onPointerCancel);
        s.addEventListener('pointerleave', this._onPointerLeave);
        s.addEventListener('pointerenter', this._onPointerEnter);
        // Ctrl/Cmd + wheel (and trackpad pinch, which browsers report as a
        // ctrl-wheel) zooms around the cursor. Non-passive so it can preventDefault.
        s.addEventListener('wheel', this._onWheel, { passive: false });
        s.addEventListener('contextmenu', this._onContextMenu);
    }

    _unbindSurfaceEvents() {
        const s = this.renderer && this.renderer.surface;
        if (!s) return;
        s.removeEventListener('pointerdown', this._onPointerDown);
        s.removeEventListener('pointermove', this._onPointerMove);
        s.removeEventListener('pointerup', this._onPointerUp);
        s.removeEventListener('pointercancel', this._onPointerCancel);
        s.removeEventListener('pointerleave', this._onPointerLeave);
        s.removeEventListener('pointerenter', this._onPointerEnter);
        s.removeEventListener('wheel', this._onWheel);
        s.removeEventListener('contextmenu', this._onContextMenu);
    }

    // Creates the visually hidden, polite live region used to announce
    // keyboard focus and selection changes to assistive technology.
    _createLiveRegion() {
        const el = document.createElement('div');
        el.setAttribute('aria-live', 'polite');
        el.setAttribute('aria-atomic', 'true');
        // Off-screen but still read by screen readers (display:none would not
        // be announced). Kept out of the layout/scroll flow.
        const s = el.style;
        s.position = 'absolute';
        s.width = '1px';
        s.height = '1px';
        s.margin = '-1px';
        s.padding = '0';
        s.border = '0';
        s.overflow = 'hidden';
        s.clip = 'rect(0 0 0 0)';
        s.clipPath = 'inset(50%)';
        s.whiteSpace = 'nowrap';
        this._liveRegion = el;
        (this.wrapper.parentElement || this.wrapper).appendChild(el);
    }

    // Announces a message to screen-reader users via the live region.
    _announce(message) {
        if (!this._liveRegion) return;
        // Re-set even if unchanged so repeated actions (e.g. hitting the last
        // bar) are still spoken; a spare space toggles the text node.
        this._liveRegion.textContent = this._liveRegion.textContent === message
            ? message + ' '
            : message;
    }

    // Observes the wrapper for viewport size (CSS pixels). This also covers
    // the initial layout: the observer fires once the wrapper has a size.
    // Renderer-specific surface observation (e.g. device-pixel tracking for
    // crisp HiDPI canvas output) lives inside the renderer itself.
    _setupResizeObserver() {
        this._resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const size = entry.contentBoxSize && entry.contentBoxSize[0];
                this._viewportW = size ? size.inlineSize : entry.contentRect.width;
                this._viewportH = size ? size.blockSize : entry.contentRect.height;
            }
            this._surfaceRect = null;
            this._relayout();
        });
        this._resizeObserver.observe(this.wrapper);
    }

    _handleScroll() {
        // Map the native (capped) scroll position onto the virtual content
        // space. _scrollScaleX is 1 unless the content exceeds the spacer cap.
        this.scrollX = this.wrapper.scrollLeft * this._scrollScaleX;
        this.scrollY = this.wrapper.scrollTop;

        // The tooltip is anchored to a screen point that no longer matches the
        // bar once the content scrolls, so dismiss it. Cheap and must not wait
        // for a frame, or it visibly lags behind the content.
        this._hideTooltip();

        // In windowed mode, scrolling may bring the visible range near the edge
        // of the loaded window; schedule a (debounced) fetch check.
        this._scheduleWindowCheck();

        // Everything else (the overlay transform, the repaint) is a write that
        // only has to land once per frame, so it is deferred to the rAF below
        // rather than run per scroll event.
        if (this._scrollRaf) {
            cancelAnimationFrame(this._scrollRaf);
        }
        this._scrollRaf = requestAnimationFrame(() => {
            if (this._hasTimeRange()) {
                // Paint on the scroll frame directly instead of scheduling a
                // second rAF inside render(), which added up to one frame of
                // lag during fast scrolling.
                if (this.animationFrame) {
                    cancelAnimationFrame(this.animationFrame);
                    this.animationFrame = null;
                }
                // _paintFrame syncs the resource overlay itself.
                this._paintFrame();
            } else {
                // Nothing to paint, but the overlay still has to track scroll.
                this._syncResourceOverlay();
            }
            this._scrollRaf = null;
        });
    }

    // A time range is all that is required to render; an empty resource list
    // simply produces an empty grid (axes only).
    _hasTimeRange() {
        return this.timeRange.start != null && this.timeRange.end != null;
    }

    // Largest width (px) the scroll spacer element is allowed to reach. Browsers
    // clamp element dimensions (~16.7M px in Chrome, ~17.1M in Firefox, more in
    // Safari); staying well under the smallest keeps the element valid. When the
    // full content is wider than this, logical scrolling maps the native
    // scrollbar onto the larger virtual range (see _relayout / _handleScroll)
    // so zoom is no longer bounded by the element-size ceiling.
    static get MAX_SPACER_PX() { return 10000000; }

    // Recomputes the effective horizontal scale (pixels per hour -> per ms) from
    // the current zoom/config and the cached viewport width. The scale is bounded
    // only by the configured min/max pixels-per-hour; the browser element-size
    // limit is handled separately by logical scrolling, not by shrinking here.
    _updateScale() {
        const c = this.config;
        this._visibleWidth = Math.max(this._viewportW - c.resourceAxisWidth, 100);

        // Effective scale: runtime zoom, else configured value, else auto-fit
        // one day to the viewport. Explicit values are clamped to the configured
        // min/max; auto-fit is used as-is.
        let pph = this._userPixelsPerHour ?? c.pixelsPerHour;
        if (pph == null || !(pph > 0)) {
            pph = (this._visibleWidth / 24);
        } else {
            pph = Math.min(Math.max(pph, c.minPixelsPerHour), c.maxPixelsPerHour);
        }

        this._pixelsPerHour = pph;
        this._pixelsPerMs = pph / (60 * 60 * 1000);
    }

    // Re-lays out the viewport: recomputes the scale, sizes the renderer's
    // surface, maintains the scroll spacer / virtual-scroll mapping, and
    // schedules a repaint. (Formerly resizeCanvas.)
    _relayout() {
        if (!this._hasTimeRange()) {
            this._syncAxisSplitterChrome();
            return;
        }

        const cssW = this._viewportW;
        const cssH = this._viewportH;
        if (cssW === 0 || cssH === 0) {
            // Hidden or not laid out yet; the ResizeObserver calls back once
            // the wrapper gets a size. Resolve pending waiters so hosts
            // awaiting whenRendered() are not left hanging.
            this._flushRenderedResolvers();
            return;
        }

        // A narrower viewport can make the current column wider than the
        // content area allows. Skip while the user is dragging the divider
        // (the drag already clamps against the live viewport).
        if (!this._axisResize) {
            const clamped = this._clampResourceAxisWidth(this.config.resourceAxisWidth);
            if (clamped !== this.config.resourceAxisWidth) {
                this.config.resourceAxisWidth = clamped;
                this._configGen++;
                this._syncAxisOverlays();
                this._notifyResourceAxisWidth(clamped);
            }
        }

        // Read the scroll position BEFORE any style is written below. Reading
        // it afterwards would force a synchronous reflow, and _relayout runs on
        // every wheel tick of a pinch-zoom. The new position is clamped against
        // the new spacer further down, exactly as the browser would.
        const rawScrollLeft = this.wrapper.scrollLeft;

        this._updateScale();
        // Which bars count as overlapping can depend on the scale just computed,
        // and the row heights read below depend on that.
        this._syncLanesToScale();

        // The surface is sticky-positioned over the viewport; the renderer
        // sizes it (and any backing store) to the viewport dimensions.
        this.renderer.resize(cssW, cssH);

        const totalHeight = this.config.timeAxisHeight + this._totalRowsHeight();
        const timeSpan = this.timeRange.end - this.timeRange.start;

        // Full (virtual) content width, which may exceed the element-size cap at
        // high zoom on long ranges. The spacer is capped; the native scrollbar is
        // then mapped onto the wider virtual range (logical scrolling).
        const virtualWidth = this.config.resourceAxisWidth + (timeSpan * this._pixelsPerMs);
        const spacerWidth = Math.min(virtualWidth, TimelineEngine.MAX_SPACER_PX);
        this._virtualWidth = virtualWidth;
        this._virtualScrollMaxX = Math.max(0, virtualWidth - cssW);
        const realScrollMax = Math.max(1, spacerWidth - cssW);
        // virtual px per real (spacer) px. Exactly 1 while uncapped.
        this._scrollScaleX = this._virtualScrollMaxX > 0
            ? this._virtualScrollMaxX / realScrollMax
            : 1;

        // A spacer element defines the scrollable area inside the wrapper. The
        // reference is cached; re-querying it on every relayout was pure waste.
        let contentDiv = this._contentDiv;
        if (!contentDiv || !contentDiv.isConnected) {
            contentDiv = document.createElement('div');
            contentDiv.className = 'timeline-content';
            contentDiv.style.position = 'absolute';
            contentDiv.style.top = '0';
            contentDiv.style.left = '0';
            contentDiv.style.pointerEvents = 'none';
            this.wrapper.appendChild(contentDiv);
            this._contentDiv = contentDiv;
            this._spacerW = -1;
            this._spacerH = -1;
        }
        // Skip the style writes when the spacer already has these dimensions;
        // most relayouts (a plain resize, a repeat zoom at the clamp) change
        // neither, and a no-op style write still dirties layout.
        if (spacerWidth !== this._spacerW) {
            contentDiv.style.width = spacerWidth + 'px';
            this._spacerW = spacerWidth;
        }
        if (totalHeight !== this._spacerH) {
            contentDiv.style.height = totalHeight + 'px';
            this._spacerH = totalHeight;
        }

        // Keep the virtual offset consistent with the (possibly re-scaled)
        // native scroll position after a resize/zoom/layout change, clamping
        // the pre-write reading to what the new spacer actually allows.
        const clampedScrollLeft = Math.max(0, Math.min(rawScrollLeft, Math.max(0, spacerWidth - cssW)));
        this.scrollX = clampedScrollLeft * this._scrollScaleX;

        // A view queued by the last data load is applied here, where the scale
        // and the scroll extent it needs are finally known, and before the
        // frame below paints - so the timeline never shows the old position.
        this._applyPendingScroll();

        // Paint in this turn. Canvas resize clears the backing store immediately;
        // deferring to rAF would present one blank frame (noticeable when a host
        // reflows on selection empty↔non-empty and the ResizeObserver runs).
        this._paintNow();
        this._syncAxisSplitterChrome();
    }

    // Cancels any pending rAF paint and paints the current scene immediately.
    _paintNow() {
        if (this.animationFrame) {
            cancelAnimationFrame(this.animationFrame);
            this.animationFrame = null;
        }
        this._paintFrame();
    }

    // Sets the horizontal scroll to a virtual offset (in content pixels),
    // mapping it back onto the capped native scrollbar. Keeps this.scrollX and
    // the DOM scrollLeft in sync so an immediate repaint is correct.
    _setVirtualScrollX(virtualX) {
        const clamped = Math.max(0, Math.min(virtualX, this._virtualScrollMaxX));
        this.scrollX = clamped;
        this.wrapper.scrollLeft = this._scrollScaleX > 0 ? clamped / this._scrollScaleX : 0;
    }

    // Vertical counterpart: clamps against the scrollable height (computed the
    // same way the spacer is, rather than read back from the DOM, so this costs
    // no reflow) and keeps scrollY and the DOM in sync.
    _setScrollY(y) {
        const maxY = Math.max(
            0, this.config.timeAxisHeight + this._totalRowsHeight() - this._viewportH);
        const clamped = Math.max(0, Math.min(y, maxY));
        this.scrollY = clamped;
        this.wrapper.scrollTop = clamped;
    }

    getTimeToX(time) {
        if (!this._hasTimeRange() || this._pixelsPerMs === 0) return 0;
        const contentX = (time - this.timeRange.start) * this._pixelsPerMs;
        return this.config.resourceAxisWidth + contentX - this.scrollX;
    }

    getXToTime(x) {
        if (!this._hasTimeRange() || this._pixelsPerMs === 0) return this.timeRange.start || 0;
        const contentX = (x - this.config.resourceAxisWidth) + this.scrollX;
        return this.timeRange.start + contentX / this._pixelsPerMs;
    }

    getResourceToY(resourceIndex) {
        return this.config.timeAxisHeight + this._rowContentTop(resourceIndex) - this.scrollY;
    }

    getYToResource(y) {
        const resourceY = y - this.config.timeAxisHeight + this.scrollY;
        return this._rowIndexAtContentY(resourceY);
    }

    // Content-space Y of the top of visible row `i` (0 at the first row).
    // Index `n` (== row count) is valid and returns the total rows height, so
    // the grid can draw the closing line under the last row.
    _rowContentTop(resourceIndex) {
        const tops = this._rowTops;
        if (!tops || resourceIndex < 0 || resourceIndex >= tops.length) {
            return resourceIndex * this.config.resourceHeight;
        }
        return tops[resourceIndex];
    }

    // Height of visible row `i`, falling back to the configured minimum.
    _rowHeight(resourceIndex) {
        const heights = this._rowHeights;
        if (!heights || resourceIndex < 0 || resourceIndex >= heights.length) {
            return this.config.resourceHeight;
        }
        return heights[resourceIndex];
    }

    // Total content height of every visible resource row.
    _totalRowsHeight() {
        const tops = this._rowTops;
        return tops && tops.length ? tops[tops.length - 1] : 0;
    }

    // Binary-searches the cumulative row tops for the row covering contentY
    // (0 at the top of the first resource row), or -1 when out of range.
    _rowIndexAtContentY(contentY) {
        const tops = this._rowTops;
        const n = this._rows.length;
        if (n === 0 || !tops || tops.length < 2 || contentY < 0 || contentY >= tops[n]) {
            return -1;
        }
        let lo = 0;
        let hi = n - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (contentY < tops[mid]) hi = mid - 1;
            else if (contentY >= tops[mid + 1]) lo = mid + 1;
            else return mid;
        }
        return -1;
    }

    // Inclusive-ish visible row window for vertical culling. Returns
    // [start, end) with a small pad so partially-visible rows still paint.
    _visibleRowWindow(pad = 1) {
        const n = this._rows.length;
        if (n === 0) return { start: 0, end: 0 };
        const viewH = Math.max(0, this._viewportH - this.config.timeAxisHeight);
        const viewTop = this.scrollY;
        const viewBottom = viewTop + viewH;

        let start = this._rowIndexAtContentY(viewTop);
        if (start < 0) start = viewTop <= 0 ? 0 : n;
        start = Math.max(0, start - pad);

        let end = this._rowIndexAtContentY(Math.max(0, viewBottom - 1e-6));
        if (end < 0) end = viewBottom <= 0 ? -1 : n - 1;
        end = Math.min(n, end + 1 + pad);
        return { start, end };
    }

    // Pixel height of one cluster's stack, measured from the top of the first
    // lane's bar to the bottom of the last lane's. Lanes that inherit the
    // default height are resolved against the current bar layout options.
    //
    // The label clearance *between* lanes counts towards the height; what the
    // outermost lanes need above and below the stack does not, because a row
    // already pads a single bar by (resourceHeight - barHeight) / 2 on each
    // side, which is what its own labels sit in (see _recomputeRowMetrics).
    _clusterStackHeight(cluster) {
        if (!cluster) return 0;
        const c = this.config;
        const heights = cluster.laneHeights;
        const count = heights.length;
        if (count === 0) return 0;
        if (count === 1) return heights[0] || c.barHeight;
        let total = 0;
        for (let i = 0; i < count; i++) {
            if (i > 0) total += c.barMargin + cluster.laneBelow[i - 1] + cluster.laneAbove[i];
            total += heights[i] || c.barHeight;
        }
        return total;
    }

    // Tallest overlapping stack on a resource row (0 when empty).
    _maxStackHeightForRow(row) {
        return row ? this._clusterStackHeight(row.maxCluster) : 0;
    }

    // Rebuilds per-visible-row heights from stack depth so overlapping bars
    // stay inside their row with the same top/bottom padding a single default
    // bar would have in a minimum-height row:
    //   rowH = max(resourceHeight, stackH + (resourceHeight - barHeight))
    _recomputeRowMetrics() {
        const c = this.config;
        const n = this._rows.length;
        const heights = new Array(n);
        const tops = new Array(n + 1);
        tops[0] = 0;
        const padTotal = Math.max(0, c.resourceHeight - c.barHeight);
        for (let i = 0; i < n; i++) {
            const row = this.allocationsByResource.get(this._rows[i].resource.id);
            const stackH = this._maxStackHeightForRow(row);
            heights[i] = Math.max(c.resourceHeight, stackH + padTotal);
            tops[i + 1] = tops[i] + heights[i];
        }
        this._rowHeights = heights;
        this._rowTops = tops;
    }

    // After barHeight/barMargin change, the tallest cluster per row may change
    // (mixed explicit heights). Rescan lane membership once; rare path.
    _refreshMaxClusterLanes() {
        for (const row of this.allocationsByResource.values()) {
            let best = null;
            let bestH = -1;
            const seen = new Set();
            for (let i = 0; i < row.items.length; i++) {
                const info = this._laneInfo.get(row.items[i]);
                if (!info || !info.cluster || seen.has(info.cluster)) continue;
                seen.add(info.cluster);
                const h = this._clusterStackHeight(info.cluster);
                if (h > bestH) {
                    bestH = h;
                    best = info.cluster;
                }
            }
            row.maxCluster = best;
        }
    }

    // Rebuilds every row's lane records. Needed when what a lane records - its
    // membership or the room it reserves - depends on an option that changed,
    // as opposed to only the pixels those records are laid out into.
    _reassignAllLanes() {
        this._laneScale = this._pixelsPerMs;
        for (const row of this.allocationsByResource.values()) {
            this._assignStackLanes(row.items, row);
        }
    }

    // Keeps lane assignment in step with the horizontal scale. Which bars
    // collide depends on it once decorations count towards an overlap, so a
    // zoom - or a resize, which moves the auto-fit scale - can change lane
    // membership and therefore row heights. Called from _relayout before the
    // row heights are read, and a no-op in the common case.
    _syncLanesToScale() {
        if (this._laneScale === this._pixelsPerMs) return;
        if (!this.config.stackOnLabelCollision) {
            // Nothing to redo, but record the scale so switching the option on
            // later is what triggers the reassignment.
            this._laneScale = this._pixelsPerMs;
            return;
        }
        this._reassignAllLanes();
        this._recomputeRowMetrics();
        this._reportResourceRows();
    }

    calculateVisibleTimeRange() {
        if (!this._hasTimeRange() || this._pixelsPerMs === 0) return null;

        const startTime = this.timeRange.start + (this.scrollX / this._pixelsPerMs);
        const endTime = startTime + (this._visibleWidth / this._pixelsPerMs);

        const padding = (endTime - startTime) * 0.1;
        return {
            start: Math.max(this.timeRange.start, startTime - padding),
            end: Math.min(this.timeRange.end, endTime + padding)
        };
    }

    render() {
        if (!this._hasTimeRange() || this._viewportW === 0 || this._viewportH === 0) {
            // Nothing will be painted; resolve pending whenRendered() waiters
            // so hosts (e.g. a loading overlay) are not left hanging.
            this._flushRenderedResolvers();
            return;
        }

        if (this.animationFrame) {
            cancelAnimationFrame(this.animationFrame);
        }

        this.animationFrame = requestAnimationFrame(() => {
            this._paintFrame();
            this.animationFrame = null;
        });
    }

    // Performs one full frame: builds the scene from the current state and
    // hands it to the renderer. Shared by render() and the scroll handler so
    // scroll-triggered updates don't incur a second rAF.
    _paintFrame() {
        // Keep the HTML resource overlay aligned (covers keyboard/programmatic
        // scroll that sets scrollY without a scroll event).
        this._syncResourceOverlay();
        // Marquee selection is recomputed at most once per frame (see
        // handlePointerMove). Doing it here also keeps the selection tracking
        // the data when the viewport scrolls mid-drag.
        if (this._marqueeDirty && this.drag && this.drag.moved) {
            this._marqueeDirty = false;
            this._applyMarqueeSelection();
        }
        try {
            this.visibleTimeRange = this.calculateVisibleTimeRange();
            if (!this.visibleTimeRange) {
                return;
            }
            this.renderer.render(this.buildScene());
            this._renderErrors = 0;
        } catch (error) {
            // A persistent render failure recurs every frame. Log the first few
            // with detail, then go quiet: at 60fps an unthrottled log buries the
            // console (and the original error) within seconds.
            this._renderErrors = (this._renderErrors || 0) + 1;
            if (this._renderErrors <= MAX_RENDER_ERROR_LOGS) {
                console.error('BlazorResourceTimeline render error:', error);
                if (this._renderErrors === MAX_RENDER_ERROR_LOGS) {
                    console.error('BlazorResourceTimeline: further render errors will be suppressed.');
                }
            }
        } finally {
            this._flushRenderedResolvers();
            this._notifyViewIfChanged();
        }
    }

    // Resolves any promises returned by whenRendered() now that a paint has
    // completed.
    _flushRenderedResolvers() {
        this._renderPending = false;
        if (this._renderedResolvers.length === 0) return;
        const resolvers = this._renderedResolvers;
        this._renderedResolvers = [];
        for (const resolve of resolvers) resolve();
    }

    // ---- Scene building ----
    //
    // The scene is a plain display list for one frame, already culled to the
    // viewport, with every coordinate in CSS pixels of viewport space. It is
    // semantic (bars, ticks, rows - not raw rects) so retained-mode renderers
    // (SVG/HTML) can produce meaningful elements, while the canvas renderer
    // paints it immediate-mode. Draw order for renderers:
    //   background -> grid -> bars -> now line -> sticky axes -> marquee -> ghost
    // Bars may extend under the axes; the (opaque) axes are drawn after them,
    // exactly like the original canvas z-order. Marquee and ghost must be
    // clipped to the content area.
    // The scene object, its arrays and the bar/day/tick nodes inside it are
    // pooled and refilled in place each frame rather than reallocated. A dense
    // frame builds hundreds of nodes, so at 60fps this was the bulk of the
    // engine's garbage. Safe because a scene describes exactly one frame and is
    // consumed synchronously by the renderer - which the contract already
    // requires, since the next frame overwrites it either way.
    _resetScene() {
        let scene = this._scene;
        if (!scene) {
            scene = this._scene = {
                config: null,
                viewport: {
                    width: 0, height: 0, axisWidth: 0, axisHeight: 0,
                    dateRowHeight: 0, utcRowY: null
                },
                days: [],
                hourTicks: [],
                utcTicks: [],
                gridH: [],
                gridV: [],
                resourceRows: null,
                bars: [],
                overflow: [],
                nonWorking: [],
                nowX: null,
                marquee: null,
                ghost: null
            };
            // Node pools, indexed in build order and grown to the busiest frame.
            this._barNodes = [];
            this._dayNodes = [];
            this._tickNodes = [];
            this._utcTickNodes = [];
            this._rowNodes = [];
            this._marqueeNode = { x: 0, y: 0, width: 0, height: 0 };
            this._ghostNode = { x: 0, y: 0, width: 0, height: 0, color: '', label: null };
        }
        scene.days.length = 0;
        scene.hourTicks.length = 0;
        scene.utcTicks.length = 0;
        scene.gridH.length = 0;
        scene.gridV.length = 0;
        scene.bars.length = 0;
        if (!scene.overflow) scene.overflow = [];
        else scene.overflow.length = 0;
        if (!scene.nonWorking) scene.nonWorking = [];
        else scene.nonWorking.length = 0;
        scene.resourceRows = null;
        scene.nowX = null;
        scene.marquee = null;
        scene.ghost = null;
        return scene;
    }

    // Pooled bar node, with every field reset so it never carries a decoration
    // from whichever bar last used this slot.
    _barNode(index) {
        let node = this._barNodes[index];
        if (node === undefined) {
            node = this._barNodes[index] = {
                id: '', x: 0, y: 0, width: 0, height: 0, color: '', selected: false,
                className: '',
                edges: null, outline: null, focusRing: null, icons: null, labels: null,
                // Reusable backing storage, attached to the public fields above
                // only when this bar actually has that decoration.
                _edges: [], _icons: [], _labels: [],
                _outline: { x: 0, y: 0, width: 0, height: 0 },
                _focusRing: { x: 0, y: 0, width: 0, height: 0 }
            };
        }
        node.edges = null;
        node.outline = null;
        node.focusRing = null;
        node.icons = null;
        node.labels = null;
        node.className = '';
        node._edges.length = 0;
        node._icons.length = 0;
        node._labels.length = 0;
        return node;
    }

    buildScene() {
        const c = this.config;
        // Contents:
        //   days       [{ sepX|null, label, labelX, labelY }]
        //   hourTicks  [{ x, label, labelY }]  the axis-zone hour row
        //   utcTicks   the same, for the optional UTC row (empty when off)
        //   gridH      horizontal grid line y positions
        //   gridV      vertical grid line x positions
        //   resourceRows  null when the HTML template overlay is active
        const scene = this._resetScene();
        // Renderers read colors/fonts/dimensions from here. This is a snapshot,
        // not the live config object: a scene describes one frame, and a
        // renderer that retains or defers one must not observe later option
        // changes through it. Rebuilt only when the config actually changes
        // (see _configSnapshot), so the common frame costs nothing.
        scene.config = this._configSnapshot();
        const viewport = scene.viewport;
        viewport.width = this._viewportW;
        viewport.height = this._viewportH;
        viewport.axisWidth = c.resourceAxisWidth;
        viewport.axisHeight = c.timeAxisHeight;
        viewport.dateRowHeight = c.dateRowHeight;
        // Y of the divider between the UTC row (above) and the zone row
        // (below), splitting the band under the day labels in two. null when
        // the UTC row is off, which is what every renderer branches on.
        viewport.utcRowY = c.showUtcTime
            ? (c.dateRowHeight + c.timeAxisHeight) / 2
            : null;
        // The zoned hour boundaries drive both the axis ticks and the vertical
        // grid lines. They are the most expensive thing in the frame (zone
        // lookups), so they are computed once here and shared.
        const step = this._hourStep();
        const hours = this._time.hourBoundaries(
            this.visibleTimeRange.start, this.visibleTimeRange.end, step);
        // The UTC row is a second, independent hour row at the same density.
        // Its boundaries are UTC whole hours, so they coincide with the zone
        // row's under a whole-hour offset and sit shifted where the offset has
        // minutes in it.
        const utcHours = c.showUtcTime
            ? utcHourBoundaries(this.visibleTimeRange.start, this.visibleTimeRange.end, step)
            : null;
        this._buildTimeAxisScene(scene, hours, utcHours);
        this._buildGridScene(scene);
        this._buildNonWorkingScene(scene);
        this._buildBarsScene(scene);
        this._buildNowScene(scene);
        this._buildResourceAxisScene(scene);
        this._buildMarqueeScene(scene);
        this._buildGhostScene(scene);
        return scene;
    }

    // Frozen copy of the config for the scene to carry. Cached and only rebuilt
    // when the config generation changes, so frames that don't change options
    // (i.e. nearly all of them) reuse the same immutable object.
    _configSnapshot() {
        if (!this._configSnap || this._configSnapGen !== this._configGen) {
            this._configSnap = Object.freeze({
                ...this.config,
                colors: Object.freeze({ ...this.config.colors })
            });
            this._configSnapGen = this._configGen;
        }
        return this._configSnap;
    }

    // Top axis row: one label per day, pinned to stay visible while the day is
    // on screen (sticky-header style), with a separator at each midnight
    // boundary. Below it, hourly ticks/labels thinned to fit the zoom - one row
    // in the axis zone, or two (UTC above it) when showUtcTime is set.
    _buildTimeAxisScene(scene, hours, utcHours) {
        const c = this.config;
        const startX = c.resourceAxisWidth;
        const visibleEndX = this._viewportW;
        const dateRowHeight = c.dateRowHeight;

        // Day labels are pinned within the day's visible span; measure with the
        // same font the renderer will draw with (config.dateLabelFont), or the
        // pinned position would not match the rendered text width.
        const ctx = this._measureCtx;
        ctx.font = c.dateLabelFont;

        let dayStart = this._time.startOfDay(this.visibleTimeRange.start);
        while (dayStart <= this.visibleTimeRange.end) {
            const dayEnd = this._time.nextDay(dayStart);
            const dayStartX = this.getTimeToX(dayStart);
            const dayEndX = this.getTimeToX(dayEnd);

            let day = this._dayNodes[scene.days.length];
            if (day === undefined) day = this._dayNodes[scene.days.length] = {};
            day.sepX = null;
            day.label = null;
            day.labelX = 0;
            day.labelY = dateRowHeight / 2;

            // Day separator at the start boundary.
            if (dayStartX >= startX && dayStartX <= visibleEndX) {
                day.sepX = dayStartX;
            }

            // Sticky-header pinning: sit at the left of the day's visible
            // span. When the next day's title approaches from the right, this
            // one is pushed left so the two never overlap, and slides out of
            // the content area (renderers clip at the resource-axis edge)
            // rather than stacking on the incoming title.
            const segLeft = Math.max(dayStartX, startX);
            const segRight = Math.min(dayEndX, visibleEndX);
            if (segRight > segLeft) {
                const label = this._time.formatDate(dayStart);
                const padding = 6;
                const textWidth = ctx.measureText(label).width;
                const preferredX = segLeft + padding;
                const pushedX = dayEndX - padding - textWidth;
                const labelX = Math.min(preferredX, pushedX);
                if (labelX + textWidth > startX && labelX < visibleEndX) {
                    day.label = label;
                    day.labelX = labelX;
                }
            }

            if (day.sepX != null || day.label != null) scene.days.push(day);
            dayStart = dayEnd;
        }

        // Hour ticks/labels, from the pre-computed boundaries. The zone row
        // occupies the whole band below the date row, or its lower half when
        // the UTC row is shown above it.
        const utcRowY = scene.viewport.utcRowY;
        const hourRowTop = utcRowY == null ? dateRowHeight : utcRowY;
        this._fillHourTicks(scene.hourTicks, this._tickNodes, hours,
            (hourRowTop + c.timeAxisHeight) / 2);
        if (utcHours) {
            this._fillHourTicks(scene.utcTicks, this._utcTickNodes, utcHours,
                (dateRowHeight + utcRowY) / 2);
        }
    }

    // Culls one row of hour boundaries to the visible span and fills `out` from
    // the given node pool. Both hour rows - the axis zone's and the optional
    // UTC one - are built through here, so they are identical but for their
    // boundaries and the row they are centered in.
    _fillHourTicks(out, pool, hours, labelY) {
        const startX = this.config.resourceAxisWidth;
        const visibleEndX = this._viewportW;

        for (let i = 0; i < hours.length; i++) {
            const x = this.getTimeToX(hours[i].ts);
            if (x < startX || x > visibleEndX) continue;
            const n = out.length;
            let tick = pool[n];
            if (tick === undefined) tick = pool[n] = {};
            tick.x = x;
            tick.label = this._time.formatHour(hours[i].hour, this.config.hour12);
            tick.labelY = labelY;
            out.push(tick);
        }
    }

    // Chooses how many hours to skip between hour ticks/labels so they stay
    // legible at the current zoom. Returns 0 when even one label per day won't
    // fit (the date row then carries the context). Steps snap to tidy divisors
    // of a day so ticks land on 0,2,3,4,6,8,12 or 24-hour marks.
    _hourStep() {
        const pph = this._pixelsPerHour;
        if (pph <= 0) return 1;
        if (pph * 24 < 48) return 0;
        const needed = 44 / pph; // desired minimum spacing between labels
        for (const n of [1, 2, 3, 4, 6, 8, 12, 24]) {
            if (n >= needed) return n;
        }
        return 24;
    }

    _buildGridScene(scene) {
        const c = this.config;
        const startY = c.timeAxisHeight;
        const visibleEndY = this._viewportH;

        const { start: visibleStart, end: visibleEnd } = this._visibleRowWindow(1);

        // Inclusive upper bound, unlike the bar/resource-axis row loops: a grid
        // line is drawn at each row's *top*, so closing the bottom edge of the
        // last row needs the line one index past it.
        for (let i = visibleStart; i <= visibleEnd; i++) {
            const y = this.getResourceToY(i);
            if (y >= startY && y <= visibleEndY) {
                scene.gridH.push(y);
            }
        }

        // Vertical lines sit exactly under the hour ticks, which the time axis
        // has already culled to the visible span - reuse them rather than
        // repeating the (expensive) zoned-hour walk.
        for (let i = 0; i < scene.hourTicks.length; i++) {
            scene.gridV.push(scene.hourTicks[i].x);
        }
    }

    // Vertical indicator at the current time, only when "now" falls within the
    // timeline's data range and the visible viewport.
    _buildNowScene(scene) {
        const now = Date.now();
        if (now < this.timeRange.start || now > this.timeRange.end) return;
        const x = this.getTimeToX(now);
        if (x < this.config.resourceAxisWidth || x > this._viewportW) return;
        scene.nowX = x;
    }

    // Weekend columns and off-hour bands, clipped to the content area.
    _buildNonWorkingScene(scene) {
        const c = this.config;
        const days = Array.isArray(c.nonWorkingDays) ? c.nonWorkingDays : [];
        const hasDays = days.length > 0;
        const startMin = c.workingHoursStart;
        const endMin = c.workingHoursEnd;
        const hasHours = startMin != null && endMin != null && endMin > startMin;
        if (!hasDays && !hasHours) return;
        if (!this._hasTimeRange() || this._pixelsPerMs === 0) return;

        const axisX = c.resourceAxisWidth;
        const axisY = c.timeAxisHeight;
        const contentW = this._viewportW - axisX;
        const contentH = this._viewportH - axisY;
        if (contentW <= 0 || contentH <= 0) return;

        const visStart = this.visibleTimeRange.start;
        const visEnd = this.visibleTimeRange.end;
        const daySet = hasDays ? new Set(days.map(d => d | 0)) : null;

        let dayStart = this._time.startOfDay(visStart);
        while (dayStart < visEnd) {
            const dayEnd = this._time.nextDay(dayStart);
            const p = this._time.parts(dayStart);
            const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
            const left = this.getTimeToX(Math.max(dayStart, visStart));
            const right = this.getTimeToX(Math.min(dayEnd, visEnd));
            const x0 = Math.max(axisX, left);
            const x1 = Math.min(this._viewportW, right);
            if (x1 > x0) {
                if (daySet && daySet.has(weekday)) {
                    scene.nonWorking.push({
                        x: x0, y: axisY, width: x1 - x0, height: contentH
                    });
                } else if (hasHours) {
                    const morningEnd = this._time.wallClockToTs(
                        p.year, p.month, p.day,
                        Math.floor(startMin / 60), startMin % 60, 0);
                    const eveningStart = this._time.wallClockToTs(
                        p.year, p.month, p.day,
                        Math.floor(endMin / 60), endMin % 60, 0);
                    const m1 = this.getTimeToX(Math.min(morningEnd, visEnd));
                    if (m1 > x0) {
                        scene.nonWorking.push({
                            x: x0, y: axisY, width: Math.min(x1, m1) - x0, height: contentH
                        });
                    }
                    const e0 = Math.max(x0, this.getTimeToX(Math.max(eveningStart, visStart)));
                    if (x1 > e0) {
                        scene.nonWorking.push({
                            x: e0, y: axisY, width: x1 - e0, height: contentH
                        });
                    }
                }
            }
            dayStart = dayEnd;
        }
    }

    _emitOverflowLabels(scene, resourceAllocations, barCenterY, startX, visibleEndX) {
        const seen = new Set();
        for (let i = 0; i < resourceAllocations.length; i++) {
            const info = this._laneInfo.get(resourceAllocations[i]);
            if (!info || !info.cluster || seen.has(info.cluster)) continue;
            seen.add(info.cluster);
            const extra = info.cluster.overflow;
            if (!extra || !extra.length) continue;
            const x = this.getTimeToX(info.cluster.trailEnd);
            if (x < startX || x > visibleEndX) continue;
            const w = 22;
            const h = 14;
            const y = barCenterY - h / 2;
            scene.overflow.push({ x, y, width: w, height: h, text: '+' + extra.length });
            this._overflowHits.push({
                x, y, width: w, height: h,
                ids: extra.map(a => a.id),
                // The cluster's own array, so hovering the same marker across
                // frames keeps one tooltip subject rather than re-arming it.
                bars: extra
            });
        }
    }

    // Resource-axis rows (labels/chevrons). Omitted entirely (null) when the
    // HTML resource-column template overlay renders them instead; the renderer
    // then only paints the axis background/border.
    _buildResourceAxisScene(scene) {
        const c = this.config;
        if (c.resourceTemplate) return;

        const startY = c.timeAxisHeight;
        const visibleEndY = this._viewportH;
        const indent = c.resourceIndent;
        const { start: visibleStart, end: visibleEnd } = this._visibleRowWindow(1);

        const rows = this._rowNodes;
        let count = 0;
        for (let i = visibleStart; i < visibleEnd; i++) {
            const y = this.getResourceToY(i);
            if (y < startY || y > visibleEndY) continue;
            const row = this._rows[i];
            let node = rows[count];
            if (node === undefined) node = rows[count] = {};
            node.midY = y + this._rowHeight(i) / 2;
            // Depth reserves room on the left; group rows get a chevron there.
            node.leftPad = 8 + row.depth * indent;
            node.name = row.resource.name;
            node.hasChildren = row.hasChildren;
            node.collapsed = row.hasChildren && this._collapsed.has(row.resource.id);
            count++;
        }
        rows.length = count;
        scene.resourceRows = rows;
    }

    _buildBarsScene(scene) {
        const c = this.config;
        this._overflowHits = [];
        const startX = c.resourceAxisWidth;
        const startY = c.timeAxisHeight;
        const visibleEndX = this._viewportW;
        const visibleEndY = this._viewportH;
        const visStart = this.visibleTimeRange.start;
        const visEnd = this.visibleTimeRange.end;

        // Only iterate resources whose row is on screen (vertical culling).
        // Variable row heights use cumulative Y + binary search, not index*h.
        const { start: firstResource, end: lastResource } = this._visibleRowWindow(1);

        for (let resourceIndex = firstResource; resourceIndex < lastResource; resourceIndex++) {
            const resource = this._rows[resourceIndex].resource;
            const resourceY = this.getResourceToY(resourceIndex);
            const rowH = this._rowHeight(resourceIndex);
            if (resourceY + rowH < startY || resourceY > visibleEndY) continue;

            const barCenterY = resourceY + rowH / 2;
            const row = this.allocationsByResource.get(resource.id);
            if (!row) continue;
            const resourceAllocations = row.items;

            // Binary-search the first allocation that can intersect the visible
            // window instead of linearly skipping everything before it. Any
            // candidate has startTime >= visStart - the row's widest span, so
            // the scan starts there and breaks once startTime passes the window.
            const firstIndex = this._firstVisibleAllocationIndex(row, visStart);
            for (let i = firstIndex; i < resourceAllocations.length; i++) {
                const alloc = resourceAllocations[i];
                const laneInfo = this._laneInfo.get(alloc);
                if (laneInfo && laneInfo.overflow) continue;
                // Time-range culling on the effective span (edge bars
                // included), so delay bars don't pop in/out at the viewport
                // edges. The list is sorted by startTime, so iteration can
                // stop once even the longest possible start edge could no
                // longer reach back into view.
                if (alloc.startTime - row.maxStartEdgeMs > visEnd) break;
                if (this._effectiveEndTime(alloc) < visStart) continue;
                if (this._effectiveStartTime(alloc) > visEnd) continue;

                // Per-bar height (falls back to the configured default),
                // centered on the row's center line - offset when the bar is
                // part of an overlapping cluster, so stacked bars are drawn
                // barMargin apart instead of on top of each other.
                const barHeight = alloc.height && alloc.height > 0 ? alloc.height : c.barHeight;
                const stackCenterY = barCenterY + this._stackOffset(alloc);
                const barTop = stackCenterY - barHeight / 2;

                const barX = this.getTimeToX(alloc.startTime);
                const barEndX = this.getTimeToX(alloc.endTime);

                // Edge (delay) bars extend the drawn span before/after the main
                // bar, so account for them when culling and when drawing.
                const startEdgeMs = alloc.startBar && alloc.startBar.duration > 0 ? alloc.startBar.duration : 0;
                const endEdgeMs = alloc.endBar && alloc.endBar.duration > 0 ? alloc.endBar.duration : 0;
                const drawStartX = startEdgeMs ? this.getTimeToX(alloc.startTime - startEdgeMs) : barX;
                const drawEndX = endEdgeMs ? this.getTimeToX(alloc.endTime + endEdgeMs) : barEndX;
                if (drawEndX < startX || drawStartX > visibleEndX) continue;

                const barWidth = Math.max(c.minBarWidth, barEndX - barX);
                const isSelected = this.selectedBars.has(alloc.id);

                const node = this._barNode(scene.bars.length);
                node.id = alloc.id;
                node.x = barX;
                node.y = barTop;
                node.width = barWidth;
                node.height = barHeight;
                node.color = alloc.color || (isSelected ? c.colors.barSelected : c.colors.bar);
                node.selected = isSelected;
                node.className = alloc.className || '';

                // Start edge bar: drawn immediately before the main bar's start.
                if (startEdgeMs) {
                    node.edges = node._edges;
                    node._edges.push({
                        x: drawStartX, y: barTop,
                        width: Math.max(c.minBarWidth, barX - drawStartX), height: barHeight,
                        color: alloc.startBar.color || c.colors.bar
                    });
                }
                // End edge bar: drawn immediately after the main bar's end.
                if (endEdgeMs) {
                    node.edges = node._edges;
                    node._edges.push({
                        x: barEndX, y: barTop,
                        width: Math.max(c.minBarWidth, drawEndX - barEndX), height: barHeight,
                        color: alloc.endBar.color || c.colors.bar
                    });
                }

                // The selection outline wraps the full span, edge bars included.
                if (isSelected) {
                    const outline = node._outline;
                    outline.x = drawStartX - 1;
                    outline.y = barTop - 1;
                    outline.width = Math.max(barWidth, drawEndX - drawStartX) + 2;
                    outline.height = barHeight + 2;
                    node.outline = outline;
                }

                // Keyboard focus ring (dashed, distinct from the solid
                // selection outline), only while the component holds focus so
                // it never lingers after the user clicks away.
                if (this._hasFocus && this._focusAlloc && this._focusAlloc.id === alloc.id) {
                    const ring = node._focusRing;
                    ring.x = drawStartX - 2;
                    ring.y = barTop - 2;
                    ring.width = Math.max(barWidth, drawEndX - drawStartX) + 4;
                    ring.height = barHeight + 4;
                    node.focusRing = ring;
                }

                // Per-bar labels and icons (only when present, to keep the
                // common path cheap). Level-of-detail: skip decorations for
                // bars too narrow to sit beside without overlapping their
                // neighbours, which also avoids a flood of unreadable,
                // overlapping text on dense timelines.
                const hasDecorations = alloc.icons?.length || alloc.textAbove || alloc.textBelow || alloc.textStart || alloc.textEnd;
                if (hasDecorations && (barEndX - barX) >= c.minBarWidthForLabels) {
                    this._buildBarDecorations(alloc, node, barX, barEndX, drawStartX, drawEndX, barTop, stackCenterY, barHeight, c);
                }

                scene.bars.push(node);
            }

            this._emitOverflowLabels(scene, resourceAllocations, barCenterY, startX, visibleEndX);
        }
    }

    // Lays out the optional icons and labels around a single bar.
    // Label positions:
    //   above  -> centered over the main bar, baseline just above it
    //   below  -> centered under the main bar, baseline just below it
    //   start  -> right-aligned, ending just before the full span's left edge
    //   end    -> left-aligned, starting just after the full span's right edge
    // Icons share these anchor positions and are laid out first; labels are
    // then pushed outward so they never overlap an icon at the same position.
    // Icons also support 'center': drawn on top of the main bar, centered in
    // both axes, several of them side by side as one centered group. An icon
    // with `inside` set keeps its anchor but is placed within the main bar,
    // against the matching edge, without displacing anything outside it.
    // spanStartX/spanEndX are the outer edges of the drawn bar including any
    // start/end edge bars, so start/end decorations never overlap them.
    _buildBarDecorations(alloc, node, barX, barEndX, spanStartX, spanEndX, barTop, barCenterY, barHeight, c) {
        const gap = c.barLabelGap;
        const barBottom = barTop + barHeight;
        const barCenterX = (barX + barEndX) / 2;

        // Outer edges, advanced as decorations are placed so multiple items at
        // the same position stack without overlapping.
        let startEdgeX = spanStartX;  // moves left for start-anchored items
        let endEdgeX = spanEndX;      // moves right for end-anchored items
        let aboveY = barTop - gap;    // bottom edge of the next above-anchored item
        let belowY = barBottom + gap; // top edge of the next below-anchored item

        // Inner edges for icons drawn inside the bar. Kept separate from the
        // outer ones so an inside icon never pushes a label away from the bar.
        let insideStartX = barX;
        let insideEndX = barEndX;
        let insideTopY = barTop;
        let insideBottomY = barBottom;

        if (alloc.icons && alloc.icons.length) {
            const defaultSize = c.barIconSize;
            // Center-anchored icons are measured in this pass and placed after
            // it, once the group's total width is known.
            let centered = null;
            let centeredWidth = 0;
            for (const icon of alloc.icons) {
                if (!icon || !icon.source) continue;
                const img = this._getImage(icon.source);
                // Skip until the image has loaded (natural size unknown until
                // then); its onload triggers a re-render.
                if (!img || !img.complete || img.naturalWidth === 0) continue;

                const box = icon.size && icon.size > 0 ? icon.size : defaultSize;
                // Fit within the square box, preserving aspect ratio.
                const ratio = img.naturalWidth / img.naturalHeight;
                let w = box, h = box;
                if (ratio >= 1) {
                    h = box / ratio;
                } else {
                    w = box * ratio;
                }

                const pos = String(icon.position || 'start').toLowerCase();
                if (pos === 'center') {
                    if (centered === null) centered = [];
                    else centeredWidth += gap;
                    centered.push({ source: icon.source, width: w, height: h });
                    centeredWidth += w;
                    continue;
                }

                let x, y;
                if (icon.inside) {
                    if (pos === 'end') {
                        x = insideEndX - gap - w;
                        y = barCenterY - h / 2;
                        insideEndX = x;
                    } else if (pos === 'above') {
                        x = barCenterX - w / 2;
                        y = insideTopY + gap;
                        insideTopY = y + h;
                    } else if (pos === 'below') {
                        x = barCenterX - w / 2;
                        y = insideBottomY - gap - h;
                        insideBottomY = y;
                    } else { // 'start' (default)
                        x = insideStartX + gap;
                        y = barCenterY - h / 2;
                        insideStartX = x + w;
                    }
                } else if (pos === 'end') {
                    x = endEdgeX + gap;
                    y = barCenterY - h / 2;
                    endEdgeX = x + w;
                } else if (pos === 'above') {
                    x = barCenterX - w / 2;
                    y = aboveY - h;
                    aboveY -= h + gap;
                } else if (pos === 'below') {
                    x = barCenterX - w / 2;
                    y = belowY;
                    belowY += h + gap;
                } else { // 'start' (default)
                    x = startEdgeX - gap - w;
                    y = barCenterY - h / 2;
                    startEdgeX = x;
                }
                node.icons = node._icons;
                node._icons.push({ source: icon.source, x, y, width: w, height: h });
            }

            if (centered !== null) {
                let x = barCenterX - centeredWidth / 2;
                node.icons = node._icons;
                for (const icon of centered) {
                    node._icons.push({
                        source: icon.source,
                        x, y: barCenterY - icon.height / 2,
                        width: icon.width, height: icon.height
                    });
                    x += icon.width + gap;
                }
            }
        }

        const labels = node._labels;
        if (alloc.textAbove) {
            labels.push({ text: alloc.textAbove, x: barCenterX, y: aboveY, align: 'center', baseline: 'bottom' });
        }
        if (alloc.textBelow) {
            labels.push({ text: alloc.textBelow, x: barCenterX, y: belowY, align: 'center', baseline: 'top' });
        }
        if (alloc.textStart) {
            labels.push({ text: alloc.textStart, x: startEdgeX - gap, y: barCenterY, align: 'right', baseline: 'middle' });
        }
        if (alloc.textEnd) {
            labels.push({ text: alloc.textEnd, x: endEdgeX + gap, y: barCenterY, align: 'left', baseline: 'middle' });
        }
        if (labels.length) node.labels = labels;
    }

    // Marquee rectangle (converting content coords back to viewport space).
    // Renderers must clip it to the content area.
    _buildMarqueeScene(scene) {
        if (!this.drag || !this.drag.moved) return;

        const c = this.config;
        const x1 = this.drag.startX - this.scrollX + c.resourceAxisWidth;
        const y1 = this.drag.startY - this.scrollY + c.timeAxisHeight;
        const x2 = this.drag.currentX - this.scrollX + c.resourceAxisWidth;
        const y2 = this.drag.currentY - this.scrollY + c.timeAxisHeight;

        const marquee = this._marqueeNode;
        marquee.x = Math.min(x1, x2);
        marquee.y = Math.min(y1, y2);
        marquee.width = Math.abs(x2 - x1);
        marquee.height = Math.abs(y2 - y1);
        scene.marquee = marquee;
    }

    // Semi-transparent preview of the allocation being edited at its proposed
    // position/size (and target row), drawn on top of the committed scene.
    // Renderers must clip it to the content area.
    _buildGhostScene(scene) {
        const ed = this.edit;
        if (!ed || !ed.moved) return;

        const c = this.config;
        const resourceY = this.getResourceToY(ed.previewResourceIndex);
        const barHeight = ed.alloc.height && ed.alloc.height > 0 ? ed.alloc.height : c.barHeight;
        // The ghost keeps the bar's committed stack lane; lanes recompute on commit.
        const barTop = resourceY + this._rowHeight(ed.previewResourceIndex) / 2
            + this._stackOffset(ed.alloc) - barHeight / 2;
        const x1 = this.getTimeToX(ed.previewStart);
        const x2 = this.getTimeToX(ed.previewEnd);

        const ghost = this._ghostNode;
        ghost.x = x1;
        ghost.y = barTop;
        ghost.width = Math.max(c.minBarWidth, x2 - x1);
        ghost.height = barHeight;
        ghost.color = ed.alloc.color || c.colors.barSelected;
        // Time readout above the ghost for precise feedback while dragging.
        ghost.label =
            `${this._time.formatDateTime(ed.previewStart)} – ${this._time.formatDateTime(ed.previewEnd)}`;
        scene.ghost = ghost;
    }

    // ---- Zone-aware date/time ----
    //
    // All wall-clock arithmetic lives in ./zoned-time.js; the engine only holds
    // the instance and rebuilds it when the zone or locale option changes.

    _rebuildDateFormatters() {
        this._time = new ZonedTime(this.config.timeZone, this.config.locale);
    }


    // Returns a cached <img> for the given source, creating and loading it on
    // first use. A completed load schedules a re-render so the icon appears as
    // soon as it is ready.
    _getImage(src) {
        let img = this.imageCache.get(src);
        if (img) {
            // Refresh recency: Map preserves insertion order, so re-inserting
            // moves this entry to the newest position for the eviction below.
            this.imageCache.delete(src);
            this.imageCache.set(src, img);
            return img;
        }

        img = new Image();
        this.imageCache.set(src, img);
        img.onload = () => {
            if (this._disposed) return;
            if (this._hasTimeRange()) this.render();
        };
        // On error the image stays incomplete (naturalWidth === 0) and is
        // simply skipped when laying out.
        img.onerror = () => { };
        img.src = src;

        // Evict least-recently-used entries once over the cap.
        while (this.imageCache.size > MAX_IMAGE_CACHE) {
            const oldest = this.imageCache.keys().next().value;
            const evicted = this.imageCache.get(oldest);
            if (evicted) { evicted.onload = null; evicted.onerror = null; }
            this.imageCache.delete(oldest);
        }
        return img;
    }

    // ---- Pointer interaction: click, Ctrl/Cmd-click, and marquee drag ----

    // Converts a viewport pointer event to surface-local coordinates, through
    // the cached surface rect (see _surfaceRect: reading it per event would
    // force a synchronous layout on every pointermove).
    _eventToCanvas(e) {
        let rect = this._surfaceRect;
        if (!rect) {
            rect = this._surfaceRect = this.renderer.surface.getBoundingClientRect();
        }
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    // True when the point lies within the scrollable content area (i.e. not on
    // either sticky axis).
    _isInContentArea(canvasX, canvasY) {
        return canvasX >= this.config.resourceAxisWidth && canvasY >= this.config.timeAxisHeight;
    }

    // Converts surface-local coordinates into scroll-independent content
    // coordinates so an in-progress marquee tracks the data while scrolling.
    _canvasToContent(canvasX, canvasY) {
        return {
            x: canvasX - this.config.resourceAxisWidth + this.scrollX,
            y: canvasY - this.config.timeAxisHeight + this.scrollY
        };
    }

    handlePointerDown(e) {
        // Most presses below preventDefault (to stop a native text/image
        // selection from starting under a marquee or edit drag), and that also
        // suppresses the browser's own focus handling - a canceled pointerdown
        // never produces the mousedown that would focus the wrapper. Without
        // this the timeline could only be focused with Tab, so every keyboard
        // shortcut looked dead after clicking it. preventScroll because the
        // wrapper *is* the scroll container: focusing it normally would scroll
        // the press out from under the pointer.
        this.wrapper.focus({ preventScroll: true });

        // Touch is reserved for native panning of the wrapper. Remember the
        // press so a quick, stationary touch can be treated as a tap-to-select
        // on release; do not capture or preventDefault so scrolling still works.
        if (e.pointerType === 'touch') {
            const { x, y } = this._eventToCanvas(e);
            this._touch = { x, y, additive: this._isAdditiveEvent(e), range: e.shiftKey };
            this._press = { pointerId: e.pointerId, x, y };
            this._suppressClick = false;
            return;
        }

        // Mouse/pen: only react to the primary (left) button.
        if (e.button !== 0) return;

        // Any press ends a hover: hide the tooltip so it doesn't linger over a
        // drag/edit or a fresh selection.
        this._hideTooltip();

        const { x: canvasX, y: canvasY } = this._eventToCanvas(e);
        this._press = { pointerId: e.pointerId, x: canvasX, y: canvasY };
        this._suppressClick = false;

        // Presses on the sticky axes clear the selection (unless modified). A
        // press on a group row in the resource axis toggles its collapsed state.
        if (!this._isInContentArea(canvasX, canvasY)) {
            if (canvasX < this.config.resourceAxisWidth && canvasY >= this.config.timeAxisHeight) {
                const rowIndex = this._rowAtY(canvasY);
                if (rowIndex >= 0 && this._rows[rowIndex].hasChildren) {
                    this._toggleGroup(this._rows[rowIndex].resource.id);
                    return;
                }
            }
            if (!this._isAdditiveEvent(e)) {
                this._clearSelectionInternal();
            }
            return;
        }

        // Editing: a press that lands on an unlocked bar begins a move/resize
        // instead of a marquee. Locked bars (and misses) fall through to marquee
        // / click-select below, unless EmptyDragAction is Create.
        if (this.config.editable) {
            const hit = this._barAt(canvasX, canvasY);
            const zone = hit && this._editZone(hit.alloc, canvasX);
            if (zone) {
                try { this.renderer.surface.setPointerCapture(e.pointerId); } catch { /* ignore */ }
                e.preventDefault();
                const content = this._canvasToContent(canvasX, canvasY);
                this.edit = {
                    pointerId: e.pointerId,
                    mode: zone,
                    alloc: hit.alloc,
                    additive: this._isAdditiveEvent(e),
                    range: e.shiftKey,
                    origStart: hit.alloc.startTime,
                    origEnd: hit.alloc.endTime,
                    origResourceId: hit.alloc.resourceId,
                    origResourceIndex: hit.resourceIndex,
                    grabX: content.x,
                    previewStart: hit.alloc.startTime,
                    previewEnd: hit.alloc.endTime,
                    previewResourceIndex: hit.resourceIndex,
                    moved: false,
                    companions: this._companionEdits(hit.alloc)
                };
                return;
            }
            if (!this._isAdditiveEvent(e) && this._isCreateEmptyDrag()) {
                const rowIndex = this.getYToResource(canvasY);
                if (rowIndex >= 0) {
                    try { this.renderer.surface.setPointerCapture(e.pointerId); } catch { /* ignore */ }
                    e.preventDefault();
                    const content = this._canvasToContent(canvasX, canvasY);
                    const start = this._snapTime(this.getXToTime(canvasX));
                    const minDuration = Math.max(1, (this.config.editMinDurationMinutes || 0) * 60000);
                    const end = start + minDuration;
                    const resourceId = this._rows[rowIndex].resource.id;
                    this.edit = {
                        pointerId: e.pointerId,
                        mode: 'create',
                        alloc: { resourceId, startTime: start, endTime: end },
                        additive: false,
                        origStart: start,
                        origEnd: end,
                        origResourceId: resourceId,
                        origResourceIndex: rowIndex,
                        grabX: content.x,
                        previewStart: start,
                        previewEnd: end,
                        previewResourceIndex: rowIndex,
                        moved: false
                    };
                    return;
                }
            }
        }

        // Route this pointer's subsequent move/up to the surface even if it
        // leaves, and prevent the press from starting a native text/image
        // selection while dragging the marquee.
        try { this.renderer.surface.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        e.preventDefault();

        const content = this._canvasToContent(canvasX, canvasY);
        this.drag = {
            pointerId: e.pointerId,
            additive: this._isAdditiveEvent(e),
            range: e.shiftKey,
            startX: content.x,
            startY: content.y,
            currentX: content.x,
            currentY: content.y,
            // Snapshot of the selection at drag start, used as the base set
            // when the drag is additive (Ctrl/Cmd held).
            baseSelection: new Set(this.selectedBars),
            moved: false
        };
    }

    // Right-click (or long-press, where the browser maps it to contextmenu):
    // the native browser menu is always suppressed - it would cover the
    // timeline - and the hit under the pointer is reported to .NET so the host
    // can show its own menu. Reports the bar (when one is hit), the resource
    // row and the time under the pointer; on the resource axis only the row.
    // Clicks on the time axis or the corner report nothing.
    handleContextMenu(e) {
        e.preventDefault();
        this._hideTooltip();

        const { x, y } = this._eventToCanvas(e);
        const hit = this._pointerHit(x, y);
        if (hit.area === 'timeAxis' || hit.area === 'corner') return;
        if (hit.area === 'resourceAxis' && !hit.resourceId) return;

        this._notifyPointer('OnTimelineContextMenu', e, hit);
    }

    // Classifies a surface point as content, resource axis, time axis or corner.
    _hitArea(canvasX, canvasY) {
        const c = this.config;
        if (canvasX < c.resourceAxisWidth && canvasY < c.timeAxisHeight) return 'corner';
        if (canvasY < c.timeAxisHeight) return 'timeAxis';
        if (canvasX < c.resourceAxisWidth) return 'resourceAxis';
        return 'content';
    }

    // Resolves what a surface point sits on: hit area, bar (or overflow
    // cluster), resource row and time. Shared by click, double-click and
    // context-menu so those events agree with selection hit-testing.
    _pointerHit(canvasX, canvasY) {
        const area = this._hitArea(canvasX, canvasY);
        let allocId = null;
        let overflowIds = null;
        let resourceId = null;
        let time = null;

        if (area === 'content') {
            const rowIndex = this.getYToResource(canvasY);
            if (rowIndex !== -1) resourceId = this._rows[rowIndex].resource.id;
            if (this._hasTimeRange()) time = Math.round(this.getXToTime(canvasX));
            const overflow = this._overflowAt(canvasX, canvasY);
            if (overflow) {
                overflowIds = overflow.ids;
            } else {
                const hit = this._barAt(canvasX, canvasY);
                if (hit) allocId = hit.alloc.id;
            }
        } else if (area === 'resourceAxis') {
            const rowIndex = this._rowAtY(canvasY);
            if (rowIndex >= 0) resourceId = this._rows[rowIndex].resource.id;
        } else if (area === 'timeAxis') {
            if (this._hasTimeRange()) time = Math.round(this.getXToTime(canvasX));
        }

        return { area, allocId, overflowIds, resourceId, time, x: canvasX, y: canvasY };
    }

    // Raises OnClick (and OnDoubleClick on the second still press) after a
    // press that never became a drag, edit or pan. Native click/dblclick are
    // not used: pointerdown preventDefault on content gestures suppresses them.
    _maybeEmitClick(e) {
        const press = this._press;
        this._press = null;
        if (!press || this._suppressClick) {
            this._suppressClick = false;
            return;
        }
        const { x, y } = this._eventToCanvas(e);
        if (Math.abs(x - press.x) > this.config.dragThreshold ||
            Math.abs(y - press.y) > this.config.dragThreshold) {
            return;
        }
        const hit = this._pointerHit(x, y);
        this._notifyPointer('OnTimelineClick', e, hit);
        if (this._recordClick(x, y)) {
            this._notifyPointer('OnTimelineDoubleClick', e, hit);
        }
    }

    // True when this still press is the even click of a double-click pair
    // (2nd, 4th, ...) within DBLCLICK_MS and dragThreshold of the previous.
    _recordClick(x, y, now) {
        const t = now != null ? now : (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const last = this._lastClick;
        const threshold = this.config.dragThreshold ?? 4;
        const within = last
            && (t - last.t) <= DBLCLICK_MS
            && Math.abs(x - last.x) <= threshold
            && Math.abs(y - last.y) <= threshold;
        const count = within ? last.count + 1 : 1;
        this._lastClick = { t, x, y, count };
        return count > 1 && count % 2 === 0;
    }

    _notifyPointer(method, e, hit) {
        if (!this.dotNetRef) return;
        this.dotNetRef.invokeMethodAsync(
            method,
            hit.allocId,
            hit.overflowIds,
            hit.resourceId,
            hit.time,
            hit.area,
            hit.x,
            hit.y,
            e.clientX,
            e.clientY,
            !!e.ctrlKey,
            !!e.shiftKey,
            !!e.metaKey,
            !!e.altKey)
            .catch((error) => console.error(
                `BlazorResourceTimeline ${method} callback failed:`, error));
    }

    handlePointerMove(e) {
        // Touch: a movement beyond the threshold means the user is panning, not
        // tapping, so cancel pending tap-to-select.
        if (e.pointerType === 'touch') {
            if (this._touch) {
                const { x, y } = this._eventToCanvas(e);
                if (Math.abs(x - this._touch.x) > this.config.dragThreshold ||
                    Math.abs(y - this._touch.y) > this.config.dragThreshold) {
                    this._touch = null;
                    this._suppressClick = true;
                }
            }
            return;
        }

        // An in-progress edit takes precedence over marquee handling: update the
        // previewed position/size and repaint the ghost.
        if (this.edit && e.pointerId === this.edit.pointerId) {
            const { x: cx, y: cy } = this._eventToCanvas(e);
            const content = this._canvasToContent(cx, cy);
            this._applyEditPreview(content, cy);
            this.render();
            return;
        }

        if (!this.drag || e.pointerId !== this.drag.pointerId) {
            // Not dragging: update the edit cursor (when editable) and the
            // hover tooltip (when enabled) for the bar under the pointer.
            this._onHoverMove(e);
            return;
        }

        const { x: canvasX, y: canvasY } = this._eventToCanvas(e);
        const content = this._canvasToContent(canvasX, canvasY);
        this.drag.currentX = content.x;
        this.drag.currentY = content.y;

        const dx = Math.abs(content.x - this.drag.startX);
        const dy = Math.abs(content.y - this.drag.startY);
        if (!this.drag.moved && (dx > this.config.dragThreshold || dy > this.config.dragThreshold)) {
            this.drag.moved = true;
        }

        if (this.drag.moved) {
            // Recomputing the selection scans every row the marquee covers, so
            // it is deferred to the paint frame rather than run per pointermove
            // (which fires several times per frame on a high-rate pointer).
            this._marqueeDirty = true;
            this.render();
        }
    }

    handlePointerUp(e) {
        // Touch: complete a tap-to-select if the touch stayed put.
        if (e.pointerType === 'touch') {
            if (this._touch) {
                const { x, y } = this._eventToCanvas(e);
                const moved = Math.abs(x - this._touch.x) > this.config.dragThreshold ||
                    Math.abs(y - this._touch.y) > this.config.dragThreshold;
                if (!moved) {
                    if (this._isInContentArea(x, y)) {
                        this._handleClickSelect(x, y, this._touch.additive, this._touch.range);
                    } else if (x < this.config.resourceAxisWidth && y >= this.config.timeAxisHeight) {
                        // Tap on a group row toggles it; otherwise clear.
                        const rowIndex = this._rowAtY(y);
                        if (rowIndex >= 0 && this._rows[rowIndex].hasChildren) {
                            this._toggleGroup(this._rows[rowIndex].resource.id);
                        } else if (!this._touch.additive) {
                            this._clearSelectionInternal();
                        }
                    } else if (!this._touch.additive) {
                        this._clearSelectionInternal();
                    }
                } else {
                    this._suppressClick = true;
                }
                this._touch = null;
            }
            this._maybeEmitClick(e);
            return;
        }

        // Finish an in-progress edit: commit if it actually moved/resized,
        // otherwise treat the press as a plain click (select the bar).
        if (this.edit && e.pointerId === this.edit.pointerId) {
            try { this.renderer.surface.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
            const ed = this.edit;
            this.edit = null;
            if (ed.moved) {
                this._suppressClick = true;
                this._commitEdit(ed).catch((error) =>
                    console.error('BlazorResourceTimeline edit commit failed:', error));
            } else {
                const { x, y } = this._eventToCanvas(e);
                this._handleClickSelect(x, y, ed.additive, ed.range);
            }
            this._maybeEmitClick(e);
            return;
        }

        if (!this.drag || e.pointerId !== this.drag.pointerId) {
            this._maybeEmitClick(e);
            return;
        }

        try { this.renderer.surface.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        const drag = this.drag;
        this.drag = null;
        this._marqueeDirty = false;

        if (drag.moved) {
            this._suppressClick = true;
            // Finalize synchronously against the drag's final rectangle: the
            // notification below must carry the selection for where the marquee
            // ended, not for the last frame that happened to paint. Compare
            // against the snapshot taken at pointer-down: paint frames already
            // wrote selectedBars, so a before/after at this point would miss
            // a real change.
            this._applyMarqueeSelection(drag);
            this.render();
            if (!this._selectionEquals(drag.baseSelection, this.selectedBars)) {
                this._notifySelection();
            }
        } else {
            // No meaningful movement: treat as a click / Ctrl-click.
            const { x: canvasX, y: canvasY } = this._eventToCanvas(e);
            this._handleClickSelect(canvasX, canvasY, drag.additive, drag.range);
        }
        this._maybeEmitClick(e);
    }

    // Aborts an in-progress interaction (e.g. the browser takes the pointer over
    // for scrolling, or the gesture is otherwise interrupted).
    handlePointerCancel(e) {
        this._touch = null;
        this._press = null;
        this._suppressClick = false;
        if (this.edit && e.pointerId === this.edit.pointerId) {
            try { this.renderer.surface.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
            // Discard the preview; the allocation keeps its original position.
            this.edit = null;
            this.render();
            return;
        }
        if (this.drag && e.pointerId === this.drag.pointerId) {
            try { this.renderer.surface.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
            this.drag = null;
            this._marqueeDirty = false;
            this.render();
        }
    }

    // Ctrl/Cmd + wheel zooms around the cursor; a plain wheel is left to the
    // browser for normal scrolling.
    handleWheel(e) {
        if (!(e.ctrlKey || e.metaKey) || !this._hasTimeRange()) return;
        e.preventDefault();
        const { x } = this._eventToCanvas(e);
        // Zoom in when the wheel moves up (negative deltaY).
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        this.zoomBy(factor, x);
    }

    // ---- Keyboard interaction (accessibility) ----
    //
    // Arrow Left/Right move a roving focus between allocations in the current
    // resource row. Up/Down move to the nearest allocation in the adjacent
    // row; Home/End jump to the first/last in the row. Enter selects the
    // focused bar (Ctrl/Cmd+Enter or Space toggles it into a multi-selection),
    // Escape clears the selection. PageUp/PageDown pan the time axis by a
    // viewport, and Ctrl/Cmd +/-/0 zoom. When editing is enabled, Alt+Left/
    // Right move the focused bar, Alt+Up/Down change its resource, Alt+Shift+
    // Left/Right resize the end edge and Alt+Shift+Up/Down resize the start
    // edge. The focused bar is scrolled into view and announced through the
    // live region so screen-reader users can follow along. Day/week panning
    // is left to the host via panByDays.
    handleKeyDown(e) {
        if (!this._hasTimeRange()) return;
        const mod = e.ctrlKey || e.metaKey;
        const key = e.key;

        if (mod && (key === '+' || key === '=')) { e.preventDefault(); this.zoomIn(); return; }
        if (mod && (key === '-' || key === '_')) { e.preventDefault(); this.zoomOut(); return; }
        if (mod && key === '0') { e.preventDefault(); this.resetZoom(); return; }

        if (mod && (key === 'c' || key === 'C') && this.config.editable) {
            e.preventDefault();
            this._copySelection();
            return;
        }
        if (mod && (key === 'v' || key === 'V') && this.config.editable) {
            e.preventDefault();
            this._pasteClipboard();
            return;
        }
        if (this.config.editable && this.config.allowDelete
            && (key === 'Delete' || key === 'Backspace')) {
            e.preventDefault();
            this._deleteSelection();
            return;
        }

        // Editing (Alt held): move/resize the focused bar by one snap step.
        //   Alt+Left/Right       move earlier/later in time
        //   Alt+Shift+Left/Right shrink/grow the end edge (resize)
        //   Alt+Up/Down          move to the previous/next resource row
        if (e.altKey && this.config.editable && this._focusAlloc) {
            const isEditKey = key === 'ArrowLeft' || key === 'ArrowRight'
                || key === 'ArrowUp' || key === 'ArrowDown';
            if (isEditKey && this._focusAlloc.locked) {
                e.preventDefault();
                this._announce('Bar is locked');
                return;
            }
            switch (key) {
                case 'ArrowLeft':
                    e.preventDefault();
                    this._keyboardEdit(e.shiftKey ? 'resize-end' : 'move-time', -1);
                    return;
                case 'ArrowRight':
                    e.preventDefault();
                    this._keyboardEdit(e.shiftKey ? 'resize-end' : 'move-time', 1);
                    return;
                case 'ArrowUp':
                    e.preventDefault();
                    // Shift resizes the start edge (grow earlier); otherwise
                    // move to the previous resource row.
                    if (e.shiftKey) this._keyboardEdit('resize-start', -1);
                    else if (this.config.allowResourceChange) this._keyboardEdit('move-resource', -1);
                    return;
                case 'ArrowDown':
                    e.preventDefault();
                    // Shift resizes the start edge (shrink later); otherwise
                    // move to the next resource row.
                    if (e.shiftKey) this._keyboardEdit('resize-start', 1);
                    else if (this.config.allowResourceChange) this._keyboardEdit('move-resource', 1);
                    return;
                default: break;
            }
        }

        switch (key) {
            case 'ArrowLeft':
                e.preventDefault();
                this._moveFocusHorizontal(-1);
                break;
            case 'ArrowRight':
                e.preventDefault();
                this._moveFocusHorizontal(1);
                break;
            case 'ArrowUp': e.preventDefault(); this._moveFocusVertical(-1); break;
            case 'ArrowDown': e.preventDefault(); this._moveFocusVertical(1); break;
            case 'Home': e.preventDefault(); this._moveFocusToEdge(-1); break;
            case 'End': e.preventDefault(); this._moveFocusToEdge(1); break;
            case 'PageUp': e.preventDefault(); this._pageScroll(-1); break;
            case 'PageDown': e.preventDefault(); this._pageScroll(1); break;
            case 'Enter': e.preventDefault(); this._toggleSelectFocused(mod); break;
            case ' ':
            case 'Spacebar': e.preventDefault(); this._toggleSelectFocused(true); break;
            case 'Escape':
                if (this.selectedBars.size) {
                    e.preventDefault();
                    this._clearSelectionInternal();
                    this._announce('Selection cleared');
                }
                break;
            default: break;
        }
    }

    // First on-screen resource row, used to seed the keyboard focus when the
    // user starts navigating without a prior focus.
    _firstVisibleResourceIndex() {
        const idx = this._rowIndexAtContentY(this.scrollY);
        const base = idx < 0 ? 0 : idx;
        return Math.max(0, Math.min(this._rows.length - 1, base));
    }

    // Allocation whose start time is closest to the given time (binary search
    // over the startTime-sorted row), used to keep the column roughly stable
    // when moving between rows.
    _nearestAllocByTime(list, time) {
        let lo = 0, hi = list.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (list[mid].startTime < time) lo = mid + 1; else hi = mid;
        }
        if (lo <= 0) return list[0];
        if (lo >= list.length) return list[list.length - 1];
        const before = list[lo - 1], after = list[lo];
        return (time - before.startTime) <= (after.startTime - time) ? before : after;
    }

    _moveFocusHorizontal(dir) {
        if (!this._rows.length) return;
        if (this._focusResource < 0) this._focusResource = this._firstVisibleResourceIndex();
        const list = this._rowIndexFor(this._rows[this._focusResource].resource.id).items;
        if (!list.length) { this._focusAlloc = null; this._announceFocus(); return; }

        let idx;
        if (!this._focusAlloc) {
            idx = dir > 0 ? 0 : list.length - 1;
        } else {
            const cur = list.indexOf(this._focusAlloc);
            idx = cur < 0 ? (dir > 0 ? 0 : list.length - 1) : cur + dir;
        }
        idx = Math.max(0, Math.min(list.length - 1, idx));
        this._focusAlloc = list[idx];
        this._scrollFocusIntoView();
        this._announceFocus();
        this.render();
    }

    _moveFocusVertical(dir) {
        if (!this._rows.length) return;
        if (this._focusResource < 0) {
            this._focusResource = this._firstVisibleResourceIndex();
        } else {
            this._focusResource = Math.max(0, Math.min(this._rows.length - 1, this._focusResource + dir));
        }
        const list = this._rowIndexFor(this._rows[this._focusResource].resource.id).items;
        if (!list.length) {
            this._focusAlloc = null;
        } else {
            const anchorTime = this._focusAlloc
                ? this._focusAlloc.startTime
                : this.getXToTime(this.config.resourceAxisWidth + this._visibleWidth / 2);
            this._focusAlloc = this._nearestAllocByTime(list, anchorTime);
        }
        this._scrollFocusIntoView();
        this._announceFocus();
        this.render();
    }

    _moveFocusToEdge(dir) {
        if (!this._rows.length) return;
        if (this._focusResource < 0) this._focusResource = this._firstVisibleResourceIndex();
        const list = this._rowIndexFor(this._rows[this._focusResource].resource.id).items;
        if (list.length) this._focusAlloc = dir < 0 ? list[0] : list[list.length - 1];
        this._scrollFocusIntoView();
        this._announceFocus();
        this.render();
    }

    // Pans the time axis by ~90% of a viewport width (keyboard paging).
    _pageScroll(dir) {
        const step = this._visibleWidth * 0.9;
        const target = Math.max(0, Math.min(this.scrollX + dir * step, this._virtualScrollMaxX));
        if (target !== this.scrollX) {
            this._setVirtualScrollX(target);
            this.render();
        }
    }

    // Instant the day-start step is measured from. After a midnight landing,
    // native scrollLeft snaps to a CSS pixel, so the lead can sit a fraction
    // of a pixel before that midnight. That must still count as the midnight
    // just landed on; otherwise the next step is a same-day realign (or a
    // skipped day going back) instead of a calendar step.
    _leadDayStartOrigin(lead) {
        const nextStart = this._time.nextDay(this._time.startOfDay(lead));
        const snapMs = (1 + 0.5 * Math.max(this._scrollScaleX, 1)) / this._pixelsPerMs;
        return nextStart - lead > 0 && nextStart - lead <= snapMs ? nextStart : lead;
    }

    // Pans the time axis by whole days (negative moves back). By default a
    // step is exactly 24 hours, keeping the same time of day at the left
    // edge. With panToDayStart, the left edge lands on a local midnight: the
    // start of the day `days` calendar days away in the configured zone, so
    // a DST 23/25-hour day is one step. A boolean second argument overrides
    // the config for this call (`null`/`undefined` keeps the option). Clamped
    // to the timeline's range, so a press at either end is a no-op. Returns
    // whether the view moved.
    panByDays(days, panToDayStart) {
        if (!this._hasTimeRange() || !(this._pixelsPerHour > 0) || !days) return false;

        const toDayStart = panToDayStart ?? this.config.panToDayStart;
        let target;
        if (toDayStart) {
            const lead = this.getXToTime(this.config.resourceAxisWidth);
            const targetTime = this._time.addDays(this._leadDayStartOrigin(lead), days);
            target = (targetTime - this.timeRange.start) * this._pixelsPerMs;
        } else {
            target = this.scrollX + days * 24 * this._pixelsPerHour;
        }
        target = Math.max(0, Math.min(target, this._virtualScrollMaxX));
        if (target === this.scrollX) return false;

        this._setVirtualScrollX(target);
        this.render();
        this._announceVisibleRange();
        return true;
    }

    // Announces where the view has landed after a pan. The bar focus has not
    // moved, so the time at the leading edge is what changed and what a
    // screen-reader user needs to hear. Formatting is skipped outright when
    // there is no live region to hear it.
    _announceVisibleRange() {
        if (!this._liveRegion) return;
        this._announce(this._time.formatDateTime(this.getXToTime(this.config.resourceAxisWidth)));
    }

    // Selects the focused bar. additive toggles it within a multi-selection;
    // otherwise it replaces the selection with just this bar.
    _toggleSelectFocused(additive) {
        if (!this._focusAlloc) return;
        const previous = new Set(this.selectedBars);
        if (additive) {
            if (this.selectedBars.has(this._focusAlloc.id)) {
                this.selectedBars.delete(this._focusAlloc.id);
            } else {
                this.selectedBars.add(this._focusAlloc.id);
            }
        } else {
            this.selectedBars.clear();
            this.selectedBars.add(this._focusAlloc.id);
        }
        this._commitSelectionIfChanged(previous);
        this._announceFocus();
    }

    // Scrolls the viewport (both axes) so the focused row and bar are visible,
    // syncing scrollX/scrollY so the immediate render is correct rather than
    // waiting for the async scroll event.
    _scrollFocusIntoView() {
        const c = this.config;
        if (this._focusResource >= 0) {
            const rowTop = this._rowContentTop(this._focusResource);
            const rowBottom = rowTop + this._rowHeight(this._focusResource);
            const viewH = Math.max(this._viewportH - c.timeAxisHeight, 0);
            const viewTop = this.scrollY;
            const viewBottom = viewTop + viewH;
            let sy = this.scrollY;
            if (rowTop < viewTop) sy = rowTop;
            else if (rowBottom > viewBottom) sy = rowBottom - viewH;
            const maxScrollTop = Math.max(0, this.wrapper.scrollHeight - this.wrapper.clientHeight);
            sy = Math.max(0, Math.min(sy, maxScrollTop));
            if (sy !== this.scrollY) { this.wrapper.scrollTop = sy; this.scrollY = sy; }
        }

        if (this._focusAlloc) {
            const margin = 24;
            const startC = this._timeToContentX(this._effectiveStartTime(this._focusAlloc));
            const endC = Math.max(startC + c.minBarWidth, this._timeToContentX(this._effectiveEndTime(this._focusAlloc)));
            const viewLeft = this.scrollX;
            const viewRight = viewLeft + this._visibleWidth;
            let sx = this.scrollX;
            if (startC < viewLeft) sx = startC - margin;
            else if (endC > viewRight) sx = endC - this._visibleWidth + margin;
            sx = Math.max(0, Math.min(sx, this._virtualScrollMaxX));
            if (sx !== this.scrollX) this._setVirtualScrollX(sx);
        }
    }

    // Announces the current keyboard focus (resource, bar time range, and
    // whether it is selected) to the live region.
    _announceFocus() {
        if (this._focusResource < 0 || this._focusResource >= this._rows.length) return;
        const resource = this._rows[this._focusResource].resource;
        if (!this._focusAlloc) {
            this._announce(`${resource.name}, no allocations`);
            return;
        }
        const a = this._focusAlloc;
        const range = `${this._time.formatDateTime(a.startTime)} to ${this._time.formatDateTime(a.endTime)}`;
        const label = a.textAbove || a.textStart || a.textEnd || a.textBelow || '';
        const selected = this.selectedBars.has(a.id) ? ', selected' : '';
        this._announce(`${resource.name}: ${label ? label + ', ' : ''}${range}${selected}`);
    }

    // Selects (or toggles) the bar under the click, or a Shift-click range.
    _handleClickSelect(canvasX, canvasY, additive, range) {
        if (!this._isInContentArea(canvasX, canvasY)) return;

        const previous = new Set(this.selectedBars);

        const overflow = this._overflowAt(canvasX, canvasY);
        if (overflow) {
            if (additive) {
                for (const id of overflow.ids) this.selectedBars.add(id);
            } else {
                this.selectedBars.clear();
                for (const id of overflow.ids) this.selectedBars.add(id);
            }
            this._selectionAnchorId = overflow.ids[0] || this._selectionAnchorId;
            this._commitSelectionIfChanged(previous);
            return;
        }

        const hit = this._barAt(canvasX, canvasY);
        const clickedBar = hit ? hit.alloc : null;

        if (additive) {
            if (clickedBar) {
                if (this.selectedBars.has(clickedBar.id)) {
                    this.selectedBars.delete(clickedBar.id);
                } else {
                    this.selectedBars.add(clickedBar.id);
                }
                this._selectionAnchorId = clickedBar.id;
            }
        } else if (range && clickedBar) {
            const fromId = this._selectionAnchorId
                || (this._focusAlloc && this._focusAlloc.id)
                || clickedBar.id;
            this._selectRange(fromId, clickedBar.id);
        } else {
            this.selectedBars.clear();
            if (clickedBar) {
                this.selectedBars.add(clickedBar.id);
                this._selectionAnchorId = clickedBar.id;
            }
        }

        this._commitSelectionIfChanged(previous);
    }

    _overflowAt(canvasX, canvasY) {
        const hits = this._overflowHits || [];
        for (let i = 0; i < hits.length; i++) {
            const h = hits[i];
            if (canvasX >= h.x && canvasX <= h.x + h.width
                && canvasY >= h.y && canvasY <= h.y + h.height) {
                return h;
            }
        }
        return null;
    }

    _selectRange(fromId, toId) {
        const order = [];
        for (let r = 0; r < this._rows.length; r++) {
            const items = this._rowIndexFor(this._rows[r].resource.id).items;
            for (let i = 0; i < items.length; i++) {
                if (!this._isOverflow(items[i])) order.push(items[i]);
            }
        }
        let i1 = -1, i2 = -1;
        for (let i = 0; i < order.length; i++) {
            if (order[i].id === fromId) i1 = i;
            if (order[i].id === toId) i2 = i;
        }
        if (i2 < 0) return;
        if (i1 < 0) i1 = i2;
        const lo = Math.min(i1, i2), hi = Math.max(i1, i2);
        this.selectedBars.clear();
        for (let i = lo; i <= hi; i++) this.selectedBars.add(order[i].id);
    }

    _isOverflow(alloc) {
        const info = this._laneInfo.get(alloc);
        return !!(info && info.overflow);
    }

    // Bar vertical band in content-space Y (row-top origin), for marquee.
    _barContentBand(alloc, resourceIndex) {
        const rowTop = this._rowContentTop(resourceIndex);
        const rowH = this._rowHeight(resourceIndex);
        const barHeight = alloc.height && alloc.height > 0 ? alloc.height : this.config.barHeight;
        const center = rowTop + rowH / 2 + this._stackOffset(alloc);
        return { top: center - barHeight / 2, bottom: center + barHeight / 2 };
    }

    // True when a modifier requesting additive selection is held.
    _isAdditiveEvent(e) {
        return e.ctrlKey || e.metaKey;
    }

    // Recomputes the selection from a marquee rectangle, combining it with the
    // snapshot taken at drag start when the drag is additive. Takes the drag
    // explicitly so pointer-up can finalize against the completed gesture after
    // this.drag has already been cleared.
    _applyMarqueeSelection(drag) {
        drag = drag || this.drag;
        if (!drag) return;

        const minX = Math.min(drag.startX, drag.currentX);
        const maxX = Math.max(drag.startX, drag.currentX);
        const minY = Math.min(drag.startY, drag.currentY);
        const maxY = Math.max(drag.startY, drag.currentY);

        const next = drag.additive ? new Set(drag.baseSelection) : new Set();

        const c = this.config;
        // Only visit rows the marquee actually covers (content-space Y).
        let firstRow = this._rowIndexAtContentY(minY);
        if (firstRow < 0) firstRow = minY < 0 ? 0 : this._rows.length;
        let lastRow = this._rowIndexAtContentY(maxY);
        if (lastRow < 0) lastRow = maxY < 0 ? -1 : this._rows.length - 1;
        firstRow = Math.max(0, firstRow);
        lastRow = Math.min(this._rows.length - 1, lastRow);
        // Left edge of the marquee in time, used to binary-search the first
        // candidate bar per row instead of scanning from the start.
        const minTime = this.timeRange.start + (minX / this._pixelsPerMs);

        for (let resourceIndex = firstRow; resourceIndex <= lastRow; resourceIndex++) {
            const resource = this._rows[resourceIndex].resource;
            const row = this.allocationsByResource.get(resource.id);
            if (!row) continue;
            const resourceAllocations = row.items;

            const firstIndex = this._firstVisibleAllocationIndex(row, minTime);
            for (let i = firstIndex; i < resourceAllocations.length; i++) {
                const alloc = resourceAllocations[i];
                // Sorted by startTime: once even the longest start edge starts
                // right of the marquee, no later bar can be inside it.
                if (this._timeToContentX(alloc.startTime - row.maxStartEdgeMs) > maxX) break;
                // Bar horizontal bounds in content space, including edge bars.
                const barStartX = this._timeToContentX(this._effectiveStartTime(alloc));
                const barEndX = Math.max(barStartX + c.minBarWidth, this._timeToContentX(this._effectiveEndTime(alloc)));
                if (barEndX < minX || barStartX > maxX) continue;
                if (this._isOverflow(alloc)) continue;
                const band = this._barContentBand(alloc, resourceIndex);
                if (band.bottom < minY || band.top > maxY) continue;
                next.add(alloc.id);
            }
        }

        this.selectedBars = next;
    }

    // ---- Editing (move / resize) ----

    // Returns the nearest bar under the given surface point and its resource row
    // index ({ alloc, resourceIndex }), or null. Mirrors the hit-testing used by
    // click selection so editing and selection agree on what is "under" a point.
    _barAt(canvasX, canvasY) {
        if (!this._isInContentArea(canvasX, canvasY)) return null;
        const resourceIndex = this.getYToResource(canvasY);
        if (resourceIndex === -1) return null;

        const resource = this._rows[resourceIndex].resource;
        const row = this._rowIndexFor(resource.id);
        const list = row.items;
        const tolerance = this.config.hitTolerance;
        const minBarWidth = this.config.minBarWidth;
        const clickTime = this.getXToTime(canvasX);
        const firstIndex = this._firstVisibleAllocationIndex(row, clickTime);
        const rowCenterY = this.getResourceToY(resourceIndex) + this._rowHeight(resourceIndex) / 2;
        let best = null;
        let bestDy = Infinity;
        let bestDx = Infinity;
        for (let i = firstIndex; i < list.length; i++) {
            const alloc = list[i];
            if (this._isOverflow(alloc)) continue;
            const barX = this.getTimeToX(alloc.startTime);
            if (barX - row.maxStartEdgeMs * this._pixelsPerMs - tolerance > canvasX) break;
            const startPx = this.getTimeToX(this._effectiveStartTime(alloc));
            const barEndX = this.getTimeToX(alloc.endTime);
            const endPx = Math.max(this.getTimeToX(this._effectiveEndTime(alloc)), barX + minBarWidth);
            if (canvasX < startPx - tolerance || canvasX > endPx + tolerance) continue;
            // Vertical distance to the bar's drawn band (0 inside it) is the
            // primary criterion so stacked overlapping bars are told apart by
            // which one is under the pointer; horizontal mid distance breaks
            // ties so clicks on empty row space still pick the nearest bar.
            const barHeight = alloc.height && alloc.height > 0 ? alloc.height : this.config.barHeight;
            const barTop = rowCenterY + this._stackOffset(alloc) - barHeight / 2;
            const dy = canvasY < barTop ? barTop - canvasY
                : canvasY > barTop + barHeight ? canvasY - barTop - barHeight
                : 0;
            const dx = Math.abs(canvasX - (barX + barEndX) / 2);
            if (dy < bestDy || (dy === bestDy && dx < bestDx)) {
                bestDy = dy;
                bestDx = dx;
                best = alloc;
            }
        }
        return best ? { alloc: best, resourceIndex } : null;
    }

    // Classifies where on a bar a press landed: near the left/right edge of the
    // main bar (within editResizeHandlePx) resizes that end; anywhere else in
    // the middle moves the whole bar. Bars too narrow for two handles only move.
    // Locked bars are not editable (null): selection and tooltips still work.
    _editZone(alloc, canvasX) {
        if (alloc.locked) return null;
        const handle = this.config.editResizeHandlePx;
        const barX = this.getTimeToX(alloc.startTime);
        const barEndX = this.getTimeToX(alloc.endTime);
        if (barEndX - barX >= handle * 2) {
            if (Math.abs(canvasX - barX) <= handle) return 'resize-start';
            if (Math.abs(canvasX - barEndX) <= handle) return 'resize-end';
        }
        return 'move';
    }

    _editSnapMs() {
        const m = this.config.editSnapMinutes;
        return m > 0 ? m * 60000 : 0;
    }

    _snapTime(t) {
        const minutes = this.config.editSnapMinutes;
        if (!(minutes > 0)) return t;
        if (this.config.snapToTimeZone === false) {
            const s = minutes * 60000;
            return Math.round(t / s) * s;
        }
        const time = this._time;
        if (!time) {
            const s = minutes * 60000;
            return Math.round(t / s) * s;
        }
        const p = time.parts(t);
        const dayStart = time.startOfDay(t);
        const dayEnd = time.nextDay(dayStart);
        const fromMidnight = p.hour * 60 + p.minute + p.second / 60;
        let snappedMin = Math.round(fromMidnight / minutes) * minutes;
        if (snappedMin <= 0) return dayStart;
        const dayLengthMin = (dayEnd - dayStart) / 60000;
        if (snappedMin >= dayLengthMin - 1e-9) return dayEnd;
        const h = Math.floor(snappedMin / 60);
        const m = Math.round(snappedMin - h * 60);
        if (h >= 24) return dayEnd;
        const ts = time.wallClockToTs(p.year, p.month, p.day, h, m, 0);
        const back = time.parts(ts);
        if (back.hour !== h || back.minute !== m) {
            // Skipped wall-clock (spring-forward): pick the nearer valid edge.
            const prev = Math.max(0, snappedMin - minutes);
            const prevH = Math.floor(prev / 60);
            const prevM = Math.round(prev - prevH * 60);
            const prevTs = prev <= 0
                ? dayStart
                : time.wallClockToTs(p.year, p.month, p.day, prevH, prevM, 0);
            const nextTs = dayEnd;
            return Math.abs(t - prevTs) <= Math.abs(nextTs - t) ? prevTs : nextTs;
        }
        return ts;
    }

    // Step size for keyboard edits: the snap increment, or 15 minutes when
    // snapping is disabled (so a keypress still makes a meaningful change).
    _editStepMs() {
        const m = this.config.editSnapMinutes;
        return (m > 0 ? m : 15) * 60000;
    }

    // Keyboard-driven move/resize of the focused allocation, mirroring the
    // pointer editing rules (snap, minimum duration, range and row clamping).
    // kind: 'move-time' | 'resize-end' | 'move-resource'; dir is -1 or +1.
    async _keyboardEdit(kind, dir) {
        const alloc = this._focusAlloc;
        if (!alloc) return;

        const c = this.config;
        const step = this._editStepMs();
        const minDuration = Math.max(1, (c.editMinDurationMinutes || 0) * 60000);
        const duration = alloc.endTime - alloc.startTime;
        const rangeStart = this.timeRange.start;
        const rangeEnd = this.timeRange.end;

        let newStart = alloc.startTime;
        let newEnd = alloc.endTime;
        let newIndex = this._focusResource;
        let verb;

        if (kind === 'resize-end') {
            let ne = this._snapTime(alloc.endTime + dir * step);
            ne = Math.min(rangeEnd, Math.max(ne, alloc.startTime + minDuration));
            newEnd = ne;
            verb = 'Resized';
        } else if (kind === 'resize-start') {
            let ns = this._snapTime(alloc.startTime + dir * step);
            ns = Math.max(rangeStart, Math.min(ns, alloc.endTime - minDuration));
            newStart = ns;
            verb = 'Resized';
        } else if (kind === 'move-resource') {
            newIndex = Math.max(0, Math.min(this._rows.length - 1, this._focusResource + dir));
            if (newIndex === this._focusResource) return;
            verb = `Moved to ${this._rows[newIndex].resource.name}`;
        } else { // move-time
            let ns = this._snapTime(alloc.startTime + dir * step);
            let ne = ns + duration;
            if (ns < rangeStart) { ns = rangeStart; ne = ns + duration; }
            if (ne > rangeEnd) { ne = rangeEnd; ns = ne - duration; }
            newStart = ns;
            newEnd = ne;
            verb = 'Moved';
        }

        if (newStart === alloc.startTime && newEnd === alloc.endTime && newIndex === this._focusResource) {
            return;
        }

        const nextResourceId = newIndex !== this._focusResource
            ? this._rows[newIndex].resource.id
            : alloc.resourceId;
        if (this.config.allowOverlap === false &&
            this._overlapsUnlocked(nextResourceId, newStart, newEnd, alloc.id)) {
            this._announce('Edit refused: overlaps another allocation');
            return;
        }

        const prevResourceId = alloc.resourceId;
        const prevStartTime = alloc.startTime;
        const prevEndTime = alloc.endTime;
        alloc.startTime = newStart;
        alloc.endTime = newEnd;
        if (newIndex !== this._focusResource) alloc.resourceId = this._rows[newIndex].resource.id;

        this._reindexAllocation(alloc, prevResourceId, prevStartTime);
        this._focusResource = newIndex;
        this._scrollFocusIntoView();
        this.render();

        const changeKind = kind === 'move-time' || kind === 'move-resource' ? 'move' : 'resize';
        const allowed = await this._askHostChanging(
            alloc, prevResourceId, prevStartTime, prevEndTime, changeKind);
        if (!allowed) {
            this._revertEdit(alloc, prevResourceId, prevStartTime, prevEndTime);
            this._announce('Edit refused');
            return;
        }
        this._announceEdit(alloc, verb);
        this._notifyEdit(alloc);
    }

    _announceEdit(alloc, verb) {
        const range = `${this._time.formatDateTime(alloc.startTime)} to ${this._time.formatDateTime(alloc.endTime)}`;
        this._announce(`${verb}: ${range}`);
    }

    // Recomputes the previewed start/end (and target resource for a move) from
    // the current pointer position, applying snapping, the minimum duration, and
    // the timeline's overall range as constraints. Sets edit.moved once the
    // preview actually differs from the original.
    _applyEditPreview(content, canvasY) {
        const ed = this.edit;
        const c = this.config;
        const duration = ed.origEnd - ed.origStart;
        const deltaTime = this._pixelsPerMs > 0 ? (content.x - ed.grabX) / this._pixelsPerMs : 0;
        const minDuration = Math.max(1, (c.editMinDurationMinutes || 0) * 60000);
        const rangeStart = this.timeRange.start;
        const rangeEnd = this.timeRange.end;

        if (ed.mode === 'resize-start') {
            let ns = this._snapTime(ed.origStart + deltaTime);
            ns = Math.max(rangeStart, Math.min(ns, ed.origEnd - minDuration));
            ed.previewStart = ns;
            ed.previewEnd = ed.origEnd;
        } else if (ed.mode === 'resize-end') {
            let ne = this._snapTime(ed.origEnd + deltaTime);
            ne = Math.min(rangeEnd, Math.max(ne, ed.origStart + minDuration));
            ed.previewStart = ed.origStart;
            ed.previewEnd = ne;
        } else if (ed.mode === 'create') {
            const pointerTime = this._snapTime(ed.origStart + deltaTime);
            let ns = Math.min(ed.origStart, pointerTime);
            let ne = Math.max(ed.origStart, pointerTime);
            if (ne - ns < minDuration) ne = ns + minDuration;
            ns = Math.max(rangeStart, ns);
            ne = Math.min(rangeEnd, Math.max(ne, ns + minDuration));
            if (ne > rangeEnd) {
                ne = rangeEnd;
                ns = Math.max(rangeStart, ne - minDuration);
            }
            ed.previewStart = ns;
            ed.previewEnd = ne;
            if (this._rows.length) {
                const contentY = canvasY - c.timeAxisHeight + this.scrollY;
                let row = this._rowIndexAtContentY(contentY);
                if (row < 0) {
                    row = contentY < 0 ? 0 : this._rows.length - 1;
                }
                ed.previewResourceIndex = Math.max(0, Math.min(this._rows.length - 1, row));
            }
        } else { // move
            let ns = this._snapTime(ed.origStart + deltaTime);
            let ne = ns + duration;
            if (ns < rangeStart) { ns = rangeStart; ne = ns + duration; }
            if (ne > rangeEnd) { ne = rangeEnd; ns = ne - duration; }
            ed.previewStart = ns;
            ed.previewEnd = ne;
            if (c.allowResourceChange && this._rows.length) {
                const contentY = canvasY - c.timeAxisHeight + this.scrollY;
                let row = this._rowIndexAtContentY(contentY);
                if (row < 0) {
                    row = contentY < 0 ? 0 : this._rows.length - 1;
                }
                ed.previewResourceIndex = Math.max(0, Math.min(this._rows.length - 1, row));
            }
        }

        if (ed.previewStart !== ed.origStart ||
            ed.previewEnd !== ed.origEnd ||
            ed.previewResourceIndex !== ed.origResourceIndex) {
            ed.moved = true;
        }
    }

    _isCreateEmptyDrag() {
        return String(this.config.emptyDragAction || 'marquee').toLowerCase() === 'create';
    }

    // Applies a completed edit to the underlying allocation, re-indexes (start
    // time and/or resource may have changed, affecting sort order and the
    // per-resource lists), asks the host to confirm, and on success notifies
    // .NET. On refusal (overlap or host false) restores the original times.
    async _commitEdit(ed) {
        if (ed.mode === 'create') {
            await this._commitCreate(ed);
            return;
        }
        if (ed.mode === 'move' && ed.companions && ed.companions.length) {
            await this._commitMultiMove(ed, ed.companions);
            return;
        }
        const alloc = ed.alloc;
        const newResource = this._rows[ed.previewResourceIndex]
            && this._rows[ed.previewResourceIndex].resource;
        const nextResourceId = newResource ? newResource.id : alloc.resourceId;
        const kind = ed.mode === 'move' ? 'move' : 'resize';

        if (this.config.allowOverlap === false &&
            this._overlapsUnlocked(nextResourceId, ed.previewStart, ed.previewEnd, alloc.id)) {
            this._announce('Edit refused: overlaps another allocation');
            this.render();
            return;
        }

        const prevResourceId = alloc.resourceId;
        const prevStartTime = alloc.startTime;
        const prevEndTime = alloc.endTime;
        alloc.startTime = ed.previewStart;
        alloc.endTime = ed.previewEnd;
        if (newResource) alloc.resourceId = newResource.id;

        this._reindexAllocation(alloc, prevResourceId, prevStartTime);
        // Stack depth (and therefore row heights / scroll spacer) may have
        // changed; relayout rather than a plain repaint.
        this._relayout();

        const allowed = await this._askHostChanging(
            alloc, prevResourceId, prevStartTime, prevEndTime, kind);
        if (!allowed) {
            this._revertEdit(alloc, prevResourceId, prevStartTime, prevEndTime);
            this._announce('Edit refused');
            return;
        }
        this._notifyEdit(alloc);
    }

    _companionEdits(primary) {
        if (!this.selectedBars.has(primary.id) || this.selectedBars.size < 2) return [];
        const out = [];
        for (const id of this.selectedBars) {
            if (id === primary.id) continue;
            const alloc = this.allocations.find(a => a.id === id);
            if (!alloc || alloc.locked) continue;
            const idx = this._rowIndexById.get(alloc.resourceId);
            if (idx === undefined) continue;
            out.push({
                alloc,
                origStart: alloc.startTime,
                origEnd: alloc.endTime,
                origResourceId: alloc.resourceId,
                origResourceIndex: idx
            });
        }
        return out;
    }

    async _commitMultiMove(ed, companions) {
        const deltaT = ed.previewStart - ed.origStart;
        const deltaRow = ed.previewResourceIndex - ed.origResourceIndex;
        const except = new Set([ed.alloc.id]);
        for (const c of companions) except.add(c.alloc.id);
        const moves = [{
            alloc: ed.alloc,
            start: ed.previewStart,
            end: ed.previewEnd,
            resourceIndex: ed.previewResourceIndex,
            prevResourceId: ed.origResourceId,
            prevStart: ed.origStart,
            prevEnd: ed.origEnd
        }];
        for (const c of companions) {
            const idx = Math.max(0, Math.min(this._rows.length - 1,
                c.origResourceIndex + (this.config.allowResourceChange ? deltaRow : 0)));
            moves.push({
                alloc: c.alloc,
                start: c.origStart + deltaT,
                end: c.origEnd + deltaT,
                resourceIndex: idx,
                prevResourceId: c.origResourceId,
                prevStart: c.origStart,
                prevEnd: c.origEnd
            });
        }
        for (const m of moves) {
            const resource = this._rows[m.resourceIndex] && this._rows[m.resourceIndex].resource;
            const rid = resource ? resource.id : m.alloc.resourceId;
            if (this.config.allowOverlap === false
                && this._overlapsUnlocked(rid, m.start, m.end, except)) {
                this._announce('Edit refused: overlaps another allocation');
                this.render();
                return;
            }
        }
        for (const m of moves) {
            const resource = this._rows[m.resourceIndex] && this._rows[m.resourceIndex].resource;
            m.alloc.startTime = m.start;
            m.alloc.endTime = m.end;
            if (resource) m.alloc.resourceId = resource.id;
            this._reindexAllocation(m.alloc, m.prevResourceId, m.prevStart);
        }
        this._relayout();
        const allowed = await this._askHostChangingMany(moves, 'move');
        if (!allowed) {
            for (const m of moves) {
                this._revertEdit(m.alloc, m.prevResourceId, m.prevStart, m.prevEnd);
            }
            this._announce('Edit refused');
            return;
        }
        for (const m of moves) this._notifyEdit(m.alloc);
    }

    async _commitCreate(ed) {
        const resource = this._rows[ed.previewResourceIndex]
            && this._rows[ed.previewResourceIndex].resource;
        if (!resource) {
            this.render();
            return;
        }
        if (this.config.allowOverlap === false &&
            this._overlapsUnlocked(resource.id, ed.previewStart, ed.previewEnd, null)) {
            this._announce('Edit refused: overlaps another allocation');
            this.render();
            return;
        }
        if (!this.dotNetRef) {
            this.render();
            return;
        }
        let created;
        try {
            created = await this.dotNetRef.invokeMethodAsync(
                'OnAllocationCreating', resource.id, ed.previewStart, ed.previewEnd);
        } catch (error) {
            console.error('BlazorResourceTimeline create callback failed:', error);
            this.render();
            return;
        }
        if (!created || !created.id) {
            this.render();
            return;
        }
        this.upsertAllocations([created]);
        this._notifyEdit(created);
    }

    // True when another unlocked bar on `resourceId` occupies overlapping
    // time (touching end-to-start is not an overlap). `exceptId` is the bar
    // being edited, so it does not conflict with itself.
    _overlapsUnlocked(resourceId, start, end, exceptId) {
        const row = this.allocationsByResource.get(resourceId);
        if (!row) return false;
        const except = exceptId instanceof Set
            ? exceptId
            : new Set(exceptId != null && exceptId !== '' ? [exceptId] : []);
        for (let i = 0; i < row.items.length; i++) {
            const other = row.items[i];
            if (except.has(other.id) || other.locked) continue;
            if (start < other.endTime && end > other.startTime) return true;
        }
        return false;
    }

    _revertEdit(alloc, prevResourceId, prevStartTime, prevEndTime) {
        const currentResourceId = alloc.resourceId;
        const currentStartTime = alloc.startTime;
        alloc.startTime = prevStartTime;
        alloc.endTime = prevEndTime;
        alloc.resourceId = prevResourceId;
        this._reindexAllocation(alloc, currentResourceId, currentStartTime);
        if (this._focusAlloc === alloc) {
            const idx = this._rowIndexById.get(prevResourceId);
            if (idx !== undefined) this._focusResource = idx;
        }
        this._relayout();
    }

    async _askHostChanging(alloc, prevResourceId, prevStart, prevEnd, kind) {
        if (!this.dotNetRef) return true;
        try {
            const allowed = await this.dotNetRef.invokeMethodAsync(
                'OnAllocationChanging',
                alloc.id, alloc.resourceId, alloc.startTime, alloc.endTime,
                prevResourceId, prevStart, prevEnd, kind);
            return allowed !== false;
        } catch (error) {
            console.error('BlazorResourceTimeline changing callback failed:', error);
            return false;
        }
    }

    async _askHostChangingMany(moves, kind) {
        if (!this.dotNetRef) return true;
        if (moves.length === 1) {
            const m = moves[0];
            return this._askHostChanging(m.alloc, m.prevResourceId, m.prevStart, m.prevEnd, kind);
        }
        try {
            const allowed = await this.dotNetRef.invokeMethodAsync(
                'OnAllocationsChanging',
                moves.map(m => m.alloc.id),
                moves.map(m => m.alloc.resourceId),
                moves.map(m => m.alloc.startTime),
                moves.map(m => m.alloc.endTime),
                moves.map(m => m.prevResourceId),
                moves.map(m => m.prevStart),
                moves.map(m => m.prevEnd),
                kind);
            return allowed !== false;
        } catch (error) {
            console.error('BlazorResourceTimeline changing callback failed:', error);
            return false;
        }
    }

    _notifyEdit(alloc) {
        if (!this.dotNetRef) return;
        this.dotNetRef.invokeMethodAsync(
            'OnAllocationEdited', alloc.id, alloc.resourceId, alloc.startTime, alloc.endTime)
            .catch((error) => console.error('BlazorResourceTimeline edit callback failed:', error));
    }

    // Handles a plain hover (no button held): updates the edit cursor (when
    // editable) and the hover tooltip (when enabled) for whatever is under the
    // pointer. A single hit-test drives both to keep hover cheap.
    _onHoverMove(e) {
        if (this._tooltip) this._tooltip.trackPointer(e.clientX, e.clientY);
        const { x, y } = this._eventToCanvas(e);
        this._hoverAt(x, y, e.clientX, e.clientY);
    }

    // The hover itself, in surface coordinates. A +N marker wins over the bars
    // beneath it, exactly as it does for a click.
    _hoverAt(canvasX, canvasY, clientX, clientY) {
        const inContent = this._isInContentArea(canvasX, canvasY);
        const overflow = inContent ? this._overflowAt(canvasX, canvasY) : null;
        const hit = inContent && !overflow ? this._barAt(canvasX, canvasY) : null;

        if (this.config.editable) {
            const zone = hit && this._editZone(hit.alloc, canvasX);
            const cursor = zone === 'move' ? 'move' : zone ? 'ew-resize' : '';
            this._setCursor(cursor);
        }

        if (!this.config.showTooltips) {
            this._notifyHover(null, clientX, clientY);
            return;
        }

        if (overflow) {
            // A marker is not a bar, so there is no allocation to hand a
            // TooltipTemplate: the built-in tooltip lists what is behind it
            // whether or not a template is set. Any template showing for a bar
            // is dismissed, since no bar is hovered now.
            this._notifyHover(null, clientX, clientY);
            this._ensureTooltip().show(
                overflow.bars,
                this._buildOverflowTooltip(overflow.bars),
                this.config.tooltipDelayMs);
            return;
        }
        if (!hit) { this._hideTooltip(); return; }

        this._notifyHover(hit.alloc.id, clientX, clientY);
        if (this.config.tooltipTemplate) return;

        const resource = this._rows[hit.resourceIndex].resource;
        this._ensureTooltip().show(
            hit.alloc,
            this._buildTooltip(hit.alloc, resource),
            this.config.tooltipDelayMs);
    }

    // Builds the tooltip text for an allocation: its explicit `tooltip` field if
    // set, otherwise a default from its label, resource name and time range.
    _buildTooltip(alloc, resource) {
        if (alloc.tooltip) return String(alloc.tooltip);
        const parts = [];
        const label = this._barLabel(alloc);
        if (label) parts.push(label);
        if (resource) parts.push(resource.name);
        parts.push(this._barTimeRange(alloc));
        return parts.join('\n');
    }

    // Builds the tooltip text for a +N marker: how many bars the lane cap hid
    // there, then one line each. Long clusters are cut off rather than allowed
    // to grow a tooltip taller than the viewport - the marker selects them all
    // on click, which is the way to see the rest.
    _buildOverflowTooltip(bars) {
        const count = bars.length;
        const lines = [count === 1 ? '1 hidden allocation' : `${count} hidden allocations`];
        const listed = Math.min(count, MAX_OVERFLOW_TOOLTIP_BARS);
        for (let i = 0; i < listed; i++) {
            const label = this._barLabel(bars[i]);
            const range = this._barTimeRange(bars[i]);
            lines.push(label ? `${label} · ${range}` : range);
        }
        if (count > listed) lines.push(`… and ${count - listed} more`);
        return lines.join('\n');
    }

    // Shortest text that identifies a bar: whichever label it carries, falling
    // back to the first line of a host-supplied tooltip.
    _barLabel(alloc) {
        const label = alloc.textAbove || alloc.textStart || alloc.textEnd || alloc.textBelow;
        if (label) return String(label);
        return alloc.tooltip ? String(alloc.tooltip).split('\n')[0] : '';
    }

    _barTimeRange(alloc) {
        return `${this._time.formatDateTime(alloc.startTime)} – ${this._time.formatDateTime(alloc.endTime)}`;
    }

    // Created on first hover: a timeline that is never hovered never puts an
    // element on <body>.
    _ensureTooltip() {
        if (!this._tooltip) {
            this._tooltip = new Tooltip({
                font: this.config.barLabelFont,
                background: this.config.colors.tooltipBg,
                color: this.config.colors.tooltipText
            });
        }
        return this._tooltip;
    }

    _hideTooltip() {
        if (this._tooltip) this._tooltip.hide();
        this._notifyHover(null, 0, 0);
    }

    _notifyHover(id, clientX, clientY) {
        if (!this.dotNetRef || !this.config.tooltipTemplate) return;
        const next = id || null;
        if (this._lastHoverId === next) return;
        this._lastHoverId = next;
        this.dotNetRef.invokeMethodAsync('OnBarHover', next, clientX, clientY)
            .catch((error) => console.error('BlazorResourceTimeline hover callback failed:', error));
    }

    // Time -> content-space X (scroll-independent), mirroring getTimeToX.
    _timeToContentX(time) {
        return (time - this.timeRange.start) * this._pixelsPerMs;
    }

    // Effective start/end times of an allocation, extended to cover any
    // start/end edge (delay) bars. Used so edge bars count as part of the bar
    // for hit-testing and selection.
    _effectiveStartTime(alloc) {
        const edge = alloc.startBar && alloc.startBar.duration > 0 ? alloc.startBar.duration : 0;
        return alloc.startTime - edge;
    }

    _effectiveEndTime(alloc) {
        const edge = alloc.endBar && alloc.endBar.duration > 0 ? alloc.endBar.duration : 0;
        return alloc.endTime + edge;
    }

    // Clears the selection without notifying .NET.
    _clearSelectionInternal() {
        if (this.selectedBars.size === 0) return;
        this.selectedBars.clear();
        this.render();
        this._notifySelection();
    }

    // True when `a` and `b` hold the same ids in the same order (Set insertion
    // order is selection order). Used so a click that leaves the selection
    // unchanged does not raise OnSelectionChanged.
    _selectionEquals(a, b) {
        if (a === b) return true;
        if (!a || !b || a.size !== b.size) return false;
        const ia = a.values();
        const ib = b.values();
        for (let i = 0; i < a.size; i++) {
            if (ia.next().value !== ib.next().value) return false;
        }
        return true;
    }

    // Renders and notifies .NET only when selectedBars differs from `previous`.
    _commitSelectionIfChanged(previous) {
        if (this._selectionEquals(previous, this.selectedBars)) return false;
        this.render();
        this._notifySelection();
        return true;
    }

    // Notifies .NET of the current selection state. Only the allocation ids
    // cross the interop boundary (the host resolves them against its own
    // data); sending the full objects could exceed Blazor Server's SignalR
    // message size limit for large marquee selections.
    _notifySelection() {
        if (!this.dotNetRef) return;

        const ids = Array.from(this.selectedBars);
        this.dotNetRef.invokeMethodAsync('OnSelectionUpdated', ids)
            .catch((error) => console.error('BlazorResourceTimeline selection callback failed:', error));
    }

    // ---- Public API invoked from .NET ----

    // Returns the fixed layout dimensions so the host can position overlays
    // (such as the top-start corner template) over the surface.
    getLayout() {
        return {
            resourceAxisWidth: this.config.resourceAxisWidth,
            timeAxisHeight: this.config.timeAxisHeight,
            resourceHeight: this.config.resourceHeight,
            resourceIndent: this.config.resourceIndent
        };
    }

    // ---- Resource-axis resize (left-panel splitter) ----

    // Hit-area width of the divider. Centered on the axis edge so a few
    // pixels on each side still grab, including when the HTML overlay covers
    // the painted border.
    static get AXIS_SPLITTER_PX() { return 8; }

    // Inclusive min/max for the resource column. The viewport always keeps
    // 100px of content area (matching _updateScale's visible-width floor);
    // a configured max of 0 means "no host cap".
    _resourceAxisWidthBounds() {
        const min = Math.max(1, this.config.resourceAxisMinWidth || 1);
        const viewportMax = Math.max(min, this._viewportW - 100);
        const configuredMax = this.config.resourceAxisMaxWidth;
        const max = configuredMax > 0 ? Math.min(configuredMax, viewportMax) : viewportMax;
        return { min, max: Math.max(min, max) };
    }

    _clampResourceAxisWidth(width) {
        const { min, max } = this._resourceAxisWidthBounds();
        const n = Number(width);
        if (!Number.isFinite(n)) return min;
        return Math.round(Math.min(Math.max(n, min), max));
    }

    // Applies a new column width: updates config, the HTML overlays that
    // Blazor sizes from getLayout(), the splitter, and the scene. notify
    // (default false) reports the committed width to .NET - used on pointer
    // up and keyboard, not on every pointermove.
    _setResourceAxisWidth(width, notify) {
        const prev = this.config.resourceAxisWidth;
        const next = this._clampResourceAxisWidth(width);
        if (next !== prev) {
            this.config.resourceAxisWidth = next;
            this._configGen++;
            this._syncAxisOverlays();
            if (this._hasTimeRange()) {
                this._relayout();
            } else {
                this.render();
                this._syncAxisSplitterChrome();
            }
        } else {
            this._syncAxisSplitterChrome();
        }
        if (notify && next !== prev) this._notifyResourceAxisWidth(next);
        return next;
    }

    _notifyResourceAxisWidth(width) {
        if (!this.dotNetRef) return;
        this.dotNetRef.invokeMethodAsync('OnResourceAxisResized', width)
            .catch((error) => console.error(
                'BlazorResourceTimeline resource-axis resize callback failed:', error));
    }

    // Writes the live width onto the Blazor-owned overlay and top-start
    // corner so they track the drag without a round-trip per pointermove.
    // C# catches up from OnResourceAxisResized after the gesture commits.
    _syncAxisOverlays() {
        const parent = this.wrapper && this.wrapper.parentElement;
        if (!parent) return;
        const w = this.config.resourceAxisWidth + 'px';
        const overlay = parent.querySelector('.timeline-resource-overlay');
        if (overlay) overlay.style.width = w;
        const corner = parent.querySelector('.timeline-top-start');
        if (corner) corner.style.width = w;
    }

    _syncAxisSplitterChrome() {
        if (!this.config.resourceAxisResizable) {
            if (this._axisSplitter) this._axisSplitter.style.display = 'none';
            return;
        }
        const el = this._ensureAxisSplitter();
        if (!el) return;
        el.style.display = '';
        el.style.left = this.config.resourceAxisWidth + 'px';
        el.style.setProperty('--timeline-splitter-hover', this.config.colors.focus);
        this._updateAxisSplitterAria();
    }

    _updateAxisSplitterAria() {
        const el = this._axisSplitter;
        if (!el) return;
        const { min, max } = this._resourceAxisWidthBounds();
        el.setAttribute('aria-valuemin', String(min));
        el.setAttribute('aria-valuemax', String(max));
        el.setAttribute('aria-valuenow', String(this.config.resourceAxisWidth));
    }

    _ensureAxisSplitter() {
        if (this._axisSplitter) return this._axisSplitter;
        const parent = this.wrapper && this.wrapper.parentElement;
        if (!parent) return null;

        const el = document.createElement('div');
        el.className = 'timeline-axis-splitter';
        el.setAttribute('role', 'separator');
        el.setAttribute('aria-orientation', 'vertical');
        el.setAttribute('aria-label', 'Resize resource column');
        el.tabIndex = 0;

        this._onAxisSplitterPointerDown = (e) => this._handleAxisSplitterPointerDown(e);
        this._onAxisSplitterPointerMove = (e) => this._handleAxisSplitterPointerMove(e);
        this._onAxisSplitterPointerUp = (e) => this._handleAxisSplitterPointerUp(e);
        this._onAxisSplitterPointerCancel = (e) => this._handleAxisSplitterPointerCancel(e);
        this._onAxisSplitterKeyDown = (e) => this._handleAxisSplitterKeyDown(e);

        el.addEventListener('pointerdown', this._onAxisSplitterPointerDown);
        el.addEventListener('pointermove', this._onAxisSplitterPointerMove);
        el.addEventListener('pointerup', this._onAxisSplitterPointerUp);
        el.addEventListener('pointercancel', this._onAxisSplitterPointerCancel);
        el.addEventListener('keydown', this._onAxisSplitterKeyDown);

        parent.appendChild(el);
        this._axisSplitter = el;
        return el;
    }

    _teardownAxisSplitter() {
        this._endAxisResize(null);
        const el = this._axisSplitter;
        if (!el) return;
        el.removeEventListener('pointerdown', this._onAxisSplitterPointerDown);
        el.removeEventListener('pointermove', this._onAxisSplitterPointerMove);
        el.removeEventListener('pointerup', this._onAxisSplitterPointerUp);
        el.removeEventListener('pointercancel', this._onAxisSplitterPointerCancel);
        el.removeEventListener('keydown', this._onAxisSplitterKeyDown);
        el.remove();
        this._axisSplitter = null;
    }

    _handleAxisSplitterPointerDown(e) {
        if (!this.config.resourceAxisResizable) return;
        if (e.pointerType !== 'touch' && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        this._hideTooltip();
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        this._axisResize = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startWidth: this.config.resourceAxisWidth
        };
        this._axisSplitter.classList.add('is-dragging');
        this._lockAxisResizeCursor();
        this._axisSplitter.focus({ preventScroll: true });
    }

    _handleAxisSplitterPointerMove(e) {
        if (!this._axisResize || e.pointerId !== this._axisResize.pointerId) return;
        e.preventDefault();
        const dx = e.clientX - this._axisResize.startX;
        this._setResourceAxisWidth(this._axisResize.startWidth + dx, false);
    }

    _handleAxisSplitterPointerUp(e) {
        if (!this._axisResize || e.pointerId !== this._axisResize.pointerId) return;
        const startWidth = this._axisResize.startWidth;
        this._endAxisResize(e.pointerId);
        const width = this.config.resourceAxisWidth;
        if (width !== startWidth) this._notifyResourceAxisWidth(width);
    }

    _handleAxisSplitterPointerCancel(e) {
        if (!this._axisResize || e.pointerId !== this._axisResize.pointerId) return;
        const startWidth = this._axisResize.startWidth;
        this._endAxisResize(e.pointerId);
        this._setResourceAxisWidth(startWidth, false);
    }

    _endAxisResize(pointerId) {
        const drag = this._axisResize;
        this._axisResize = null;
        if (this._axisSplitter) this._axisSplitter.classList.remove('is-dragging');
        this._unlockAxisResizeCursor();
        if (drag && pointerId != null) {
            try { this._axisSplitter && this._axisSplitter.releasePointerCapture(pointerId); }
            catch { /* ignore */ }
        }
    }

    _lockAxisResizeCursor() {
        if (this._axisResizeCursorLocked) return;
        if (typeof document === 'undefined' || !document.body) return;
        this._axisResizeCursorLocked = true;
        this._prevBodyCursor = document.body.style.cursor;
        this._prevBodyUserSelect = document.body.style.userSelect;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    }

    _unlockAxisResizeCursor() {
        if (!this._axisResizeCursorLocked) return;
        this._axisResizeCursorLocked = false;
        if (typeof document === 'undefined' || !document.body) return;
        document.body.style.cursor = this._prevBodyCursor || '';
        document.body.style.userSelect = this._prevBodyUserSelect || '';
    }

    _handleAxisSplitterKeyDown(e) {
        if (!this.config.resourceAxisResizable) return;
        const key = e.key;
        const { min, max } = this._resourceAxisWidthBounds();
        let next = null;
        const step = e.shiftKey ? 50 : 10;
        if (key === 'ArrowLeft') next = this.config.resourceAxisWidth - step;
        else if (key === 'ArrowRight') next = this.config.resourceAxisWidth + step;
        else if (key === 'Home') next = min;
        else if (key === 'End') next = max;
        else return;
        e.preventDefault();
        e.stopPropagation();
        this._setResourceAxisWidth(next, true);
    }

    // ---- HTML resource-column template ----

    // Enables the HTML resource-column overlay: the renderer stops drawing
    // labels, the overlay element is translated to follow vertical scroll, and
    // the current rows are reported to .NET so it can render the templates.
    enableResourceTemplate(overlayInner) {
        this.config.resourceTemplate = true;
        this._resourceOverlay = overlayInner || null;
        this._reportResourceRows();
        this._syncResourceOverlay();
        this.render();
    }

    enableTooltipTemplate() {
        this.config.tooltipTemplate = true;
    }

    // Public toggle so the HTML overlay's chevrons can collapse/expand groups.
    toggleGroup(id) {
        if (!id) return;
        this._toggleGroup(id);
    }

    // Reports the ordered visible rows to .NET (id, name, depth, group state) so
    // the HTML overlay can render one template per row. Cheap: rows are bounded.
    _reportResourceRows() {
        if (!this.dotNetRef || !this.config.resourceTemplate) return;
        const rows = this._rows.map((r, i) => ({
            id: r.resource.id,
            name: r.resource.name,
            depth: r.depth,
            hasChildren: r.hasChildren,
            collapsed: this._collapsed.has(r.resource.id),
            height: this._rowHeight(i)
        }));
        this.dotNetRef.invokeMethodAsync('OnResourceRowsChanged', rows)
            .catch((error) => console.error('BlazorResourceTimeline rows callback failed:', error));
    }

    // Translates the overlay's inner element to mirror vertical scroll (done in
    // JS so scrolling stays smooth without per-pixel interop).
    _syncResourceOverlay() {
        if (this._resourceOverlay) {
            this._resourceOverlay.style.transform = `translateY(${-this.scrollY}px)`;
        }
    }

    // Virtual horizontal offset (in content pixels) that puts the given time at
    // the center of the content area, clamped to the scrollable extent. Returns
    // null when the time is outside the timeline's range or nothing is laid out.
    _centerVirtualX(time) {
        if (!this._hasTimeRange() || this._pixelsPerMs === 0) return null;
        if (time < this.timeRange.start || time > this.timeRange.end) return null;

        const contentX = (time - this.timeRange.start) * this._pixelsPerMs;
        return Math.max(0, Math.min(contentX - this._visibleWidth / 2, this._virtualScrollMaxX));
    }

    // Scrolls horizontally so the given time is centered in the content area.
    // Returns true if the time is within range and navigation happened.
    scrollToTime(time) {
        const targetVirtual = this._centerVirtualX(time);
        if (targetVirtual === null) return false;

        // Map onto the capped native scrollbar for the smooth scroll.
        const targetScrollLeft = this._scrollScaleX > 0 ? targetVirtual / this._scrollScaleX : 0;
        this.wrapper.scrollTo({ left: targetScrollLeft, behavior: 'smooth' });
        return true;
    }

    // Navigates to the current time. Returns true if "now" is within the
    // timeline's data range (and navigation happened), false otherwise.
    goToNow() {
        return this.scrollToTime(Date.now());
    }

    // ---- View continuity across data loads ----

    // Called by every data-load entry point *before* it replaces the data,
    // while the outgoing view can still be read. The first load is where
    // autoScrollToNow applies and where there is nothing to preserve; later
    // loads capture the current view for preserveScrollOnReload. Either way the
    // result is applied by _applyPendingScroll on the next layout.
    _prepareLoadScroll() {
        if (!this._firstLoadDone) {
            this._firstLoadDone = true;
            if (this.config.autoScrollToNow) this._pendingScroll = { centerOnNow: true };
            return;
        }

        if (this.config.preserveScrollOnReload) {
            const anchor = this._captureViewAnchor();
            if (anchor) this._pendingScroll = anchor;
        }
    }

    // What the viewport is showing, described in terms that survive a reload:
    // the time at the left edge of the content area, and the row at the top of
    // it (by id, plus how far into that row the edge falls). A reload that
    // changes the scale, the overall range or the row list invalidates raw
    // pixel offsets, but not these.
    _captureViewAnchor() {
        if (!this._hasTimeRange() || this._pixelsPerMs === 0) return null;

        const anchor = this._captureRowAnchor();
        anchor.leadTime = this.getXToTime(this.config.resourceAxisWidth);
        return anchor;
    }

    // The vertical half of a view anchor: the row at the top of the content area
    // and how far into it the edge falls. Survives a change of row heights, which
    // raw pixel offsets do not.
    _captureRowAnchor() {
        const anchor = { scrollY: this.scrollY, rowId: null, rowOffset: 0 };
        const topRow = this._rowIndexAtContentY(this.scrollY);
        if (topRow >= 0) {
            anchor.rowId = this._rows[topRow].resource.id;
            anchor.rowOffset = this.scrollY - this._rowContentTop(topRow);
        }
        return anchor;
    }

    // Puts the anchored row back at the top of the content area. A row that is
    // gone falls back to the raw vertical offset, which is as close as anything
    // gets once the row is no longer there.
    _restoreRowAnchor(anchor) {
        let y = anchor.scrollY;
        if (anchor.rowId !== null) {
            const index = this._rowIndexById.get(anchor.rowId);
            if (index !== undefined) y = this._rowContentTop(index) + anchor.rowOffset;
        }
        this._setScrollY(y);
    }

    // Applies the view queued by _prepareLoadScroll against the layout that has
    // just been computed. Nothing is scheduled in the common case, so this is a
    // single null check on the hot resize path.
    _applyPendingScroll() {
        const pending = this._pendingScroll;
        if (!pending) return;
        this._pendingScroll = null;

        if (pending.centerOnNow) {
            const target = this._centerVirtualX(Date.now());
            // "Now" outside the loaded range leaves nothing to center on; the
            // view simply stays where it started.
            if (target !== null) this._setVirtualScrollX(target);
            return;
        }

        this._restoreViewAnchor(pending);
    }

    // Puts a captured view back: the anchored time returns to the left edge of
    // the content area and the anchored row to the top. A row that the reload
    // removed (or collapsed away) falls back to the raw vertical offset, which
    // is as close as anything gets once the row is gone.
    _restoreViewAnchor(anchor) {
        this._setVirtualScrollX((anchor.leadTime - this.timeRange.start) * this._pixelsPerMs);
        this._restoreRowAnchor(anchor);
    }

    // Rebuilds the resource hierarchy (children map + roots), seeds the initial
    // collapsed set from resource flags, then flattens to the visible rows.
    // Called whenever the resource list is replaced.
    _rebuildResourceStructure() {
        const childrenById = new Map();
        const roots = [];
        const byId = new Map();
        for (const r of this.resources) byId.set(r.id, r);

        // A resource whose parent chain loops back on itself is unreachable from
        // any root and would silently vanish from the timeline, so cycle members
        // are promoted to top-level rows instead.
        //
        // Each id is classified once and the result memoized, making this linear
        // overall - walking every resource's chain independently would be
        // quadratic on a deeply nested hierarchy.
        const UNSETTLED = 1, SAFE = 2, CYCLIC = 3;
        const state = new Map();

        const classify = (startId) => {
            const path = [];
            let id = startId;
            for (;;) {
                const s = state.get(id);
                if (s === UNSETTLED) {
                    // Closed a loop. The cycle is the path from where this id
                    // first appeared; anything before that merely leads into the
                    // cycle and still reaches a row, since cycle members become
                    // roots below.
                    const at = path.indexOf(id);
                    for (let i = 0; i < at; i++) state.set(path[i], SAFE);
                    for (let i = at; i < path.length; i++) state.set(path[i], CYCLIC);
                    return;
                }
                if (s === SAFE || s === CYCLIC) break;   // reached settled ground
                const r = byId.get(id);
                if (!r) break;
                state.set(id, UNSETTLED);
                path.push(id);
                const pid = r.parentId;
                if (pid == null || pid === id || !byId.has(pid)) break;
                id = pid;
            }
            // This whole chain terminates at a root, so none of it is in a cycle.
            for (const p of path) state.set(p, SAFE);
        };

        for (const r of this.resources) {
            if (!state.has(r.id)) classify(r.id);
        }

        let cycles = 0;
        for (const r of this.resources) {
            const pid = r.parentId;
            if (pid != null && pid !== r.id && byId.has(pid) && state.get(r.id) !== CYCLIC) {
                let arr = childrenById.get(pid);
                if (!arr) { arr = []; childrenById.set(pid, arr); }
                arr.push(r);
            } else {
                if (pid != null && pid !== r.id && byId.has(pid)) cycles++;
                roots.push(r);
            }
        }
        if (cycles > 0) {
            console.warn(`BlazorResourceTimeline: ${cycles} resource(s) are in a parentId ` +
                `cycle and have been treated as top-level rows.`);
        }
        this._childrenById = childrenById;
        this._resourceRoots = roots;
        this._resourceIdSet = new Set(this.resources.map(r => r.id));

        // Seed collapsed state from the resources' initial flags (fresh on every
        // data load; runtime toggles live in _collapsed until the next load).
        this._collapsed = new Set();
        for (const r of this.resources) {
            if (r.collapsed && childrenById.has(r.id)) this._collapsed.add(r.id);
        }

        this._rebuildRows();
    }

    // Flattens the hierarchy into the ordered list of visible rows, skipping the
    // descendants of collapsed groups.
    _rebuildRows() {
        const rows = [];
        const idIndex = new Map();
        // Explicit stack rather than recursion: hierarchy depth comes from host
        // data and is not bounded, so a deep tree could blow the call stack.
        // Roots are pushed in reverse so they pop in input order.
        const stack = [];
        for (let i = this._resourceRoots.length - 1; i >= 0; i--) {
            stack.push({ resource: this._resourceRoots[i], depth: 0 });
        }
        while (stack.length) {
            const { resource, depth } = stack.pop();
            const kids = this._childrenById.get(resource.id);
            const hasChildren = !!(kids && kids.length);
            idIndex.set(resource.id, rows.length);
            rows.push({ resource, depth, hasChildren });
            if (hasChildren && !this._collapsed.has(resource.id)) {
                for (let i = kids.length - 1; i >= 0; i--) {
                    stack.push({ resource: kids[i], depth: depth + 1 });
                }
            }
        }
        this._rows = rows;
        this._rowIndexById = idIndex;
        this._recomputeRowMetrics();
        this._reportResourceRows();
    }

    // Visible-row index at a surface y (content or resource-axis band), or -1.
    _rowAtY(canvasY) {
        const c = this.config;
        if (canvasY < c.timeAxisHeight) return -1;
        return this._rowIndexAtContentY(canvasY - c.timeAxisHeight + this.scrollY);
    }

    // Toggles a group row's collapsed state and re-lays out. Keeps the focused
    // bar's resource resolvable by remapping focus through row ids.
    _toggleGroup(id) {
        if (this._collapsed.has(id)) this._collapsed.delete(id);
        else this._collapsed.add(id);

        const focusId = (this._focusResource >= 0 && this._focusResource < this._rows.length)
            ? this._rows[this._focusResource].resource.id
            : null;

        this._rebuildRows();
        this._hideTooltip();

        // A collapsed ancestor can hide the focused row; drop focus in that case.
        this._focusResource = focusId != null && this._rowIndexById.has(focusId)
            ? this._rowIndexById.get(focusId)
            : -1;
        if (this._focusResource < 0) this._focusAlloc = null;

        this._announce(`${this._collapsed.has(id) ? 'Collapsed' : 'Expanded'} group`);
        // Total content height changed, so re-lay out the scroll spacer + repaint.
        this._relayout();
    }

    // Rebuilds the resourceId -> sorted allocations index used for rendering
    // and hit-testing, and records the largest start/end edge (delay) bar
    // durations and widest effective span. Lists are sorted by startTime, but
    // effective start times (startTime minus the start edge) are not monotonic,
    // so scans that early-exit on startTime widen their window by these maxima.
    _indexAllocations() {
        // A host may hand back the same allocation objects with different labels,
        // so the measurements taken from them do not survive a re-index.
        this._decorBoxes = new WeakMap();
        const index = new Map();
        for (const alloc of this.allocations) {
            let row = index.get(alloc.resourceId);
            if (!row) {
                row = this._newRowIndex();
                index.set(alloc.resourceId, row);
            }
            row.items.push(alloc);
            this._widenRowBounds(row, alloc);
        }
        this.allocationsByResource = index;
        // Each resource's list inherits global sort order, so it is already
        // sorted by startTime (which the lane assignment relies on).
        this._reassignAllLanes();
        this._recomputeRowMetrics();
        this._reportResourceRows();
    }

    _newRowIndex() {
        return { items: [], maxStartEdgeMs: 0, maxSpanMs: 0, maxCluster: null };
    }

    // Widens a row's cached scan bounds to cover one allocation. These bound
    // how far back a startTime-sorted scan of that row has to look. They are
    // deliberately per row rather than global: one very long allocation (or one
    // with a huge start edge) would otherwise force every scan of every row in
    // the timeline to widen, undoing the binary search entirely.
    _widenRowBounds(row, alloc) {
        const startEdge = alloc.startBar && alloc.startBar.duration > 0 ? alloc.startBar.duration : 0;
        const endEdge = alloc.endBar && alloc.endBar.duration > 0 ? alloc.endBar.duration : 0;
        if (startEdge > row.maxStartEdgeMs) row.maxStartEdgeMs = startEdge;
        const span = (alloc.endTime - alloc.startTime) + startEdge + endEdge;
        if (span > row.maxSpanMs) row.maxSpanMs = span;
    }

    // The allocations of one resource row, or an empty row index when it has
    // none. Never returns null, so callers can scan unconditionally.
    _rowIndexFor(resourceId) {
        return this.allocationsByResource.get(resourceId) || EMPTY_ROW_INDEX;
    }

    // Assigns vertical stacking lanes within one row's startTime-sorted
    // allocation list so bars that overlap in time are drawn apart instead of
    // on top of each other (see the barMargin option). Bars are grouped into
    // clusters (maximal runs of transitively-overlapping bars); within a
    // cluster each bar takes the first lane free at its start time, and every
    // member is recorded in _laneInfo against a shared cluster record so
    // rendering can center the whole stack on the row's center line. Bars that
    // overlap nothing form
    // single-lane clusters and stay centered exactly as before. Touching bars
    // (one ends the instant the next starts) do not count as overlapping.
    //
    // What counts as an overlap is the span each bar *paints* over, not just the
    // time it occupies: with stackOnLabelCollision two bars whose labels, icons
    // or delay bars would collide are stacked as well, which is the only way
    // their text is readable. That span is measured in pixels, so it depends on
    // the current scale (see _paintedSpan and _syncLanesToScale).
    //
    // Each lane also records the tallest explicit per-bar height it holds (0
    // when every bar in it uses the configured default), so _stackOffset can
    // lay lanes out by their real heights, plus the vertical room its bars'
    // labels and icons need above and below them (stackLabelClearance), so
    // neighbouring lanes are spread far enough apart to keep those readable.
    // Only lane membership is decided here - the pixel offsets depend on
    // barHeight/barMargin, which can change via setOptions without reloading
    // data, so they are derived lazily.
    //
    // When `row` is provided, its maxCluster is updated so variable row heights
    // can grow to keep deep stacks inside the row with consistent top/bottom
    // padding.
    _assignStackLanes(list, row) {
        let clusterStart = 0;
        let clusterMaxEnd = -Infinity;
        let laneEnds = [];
        let laneHeights = [];
        let laneAbove = [];
        let laneBelow = [];
        // A lower bound on every lane's end time. Kept as a bound rather than
        // the exact minimum so it can be maintained in O(1): it is only ever
        // lowered, and a too-low value merely falls back to the scan below
        // (still correct). When it exceeds the current bar's start time, no
        // lane can be free and the scan is skipped outright - which is exactly
        // the degenerate row of mutually overlapping bars that would otherwise
        // make lane assignment quadratic.
        let laneEndLowerBound = Infinity;

        if (row) row.maxCluster = null;

        const c = this.config;
        const maxLanes = c.maxStackLanes > 0 ? c.maxStackLanes : 0;
        const clearance = c.stackLabelClearance;
        // Scale at which the painted footprint is measured, or 0 to cluster by
        // time alone. There is no scale before the first layout; _syncLanesToScale
        // reassigns once there is one.
        const scale = c.stackOnLabelCollision && this._pixelsPerMs > 0 ? this._pixelsPerMs : 0;
        // Bound on how far back into the row any bar paints. Padded starts are
        // not in the list's (raw) start order, so a cluster may only be closed
        // where no bar still to come could reach back into it.
        let maxLead = 0;
        if (scale) {
            for (let i = 0; i < list.length; i++) {
                const lead = this._paintedSpan(list[i], scale, this._spanScratch).lead;
                if (lead > maxLead) maxLead = lead;
            }
        }
        let overflow = [];

        const laneInfo = this._laneInfo;
        const closeCluster = (endIndex) => {
            const cluster = {
                laneHeights, laneAbove, laneBelow, offsets: null, key: null,
                overflow, trailEnd: clusterMaxEnd
            };
            for (let j = clusterStart; j < endIndex; j++) {
                const info = laneInfo.get(list[j]);
                if (info) info.cluster = cluster;
            }
            if (row && laneHeights.length
                && this._clusterStackHeight(cluster) > this._clusterStackHeight(row.maxCluster)) {
                row.maxCluster = cluster;
            }
            overflow = [];
        };

        for (let i = 0; i < list.length; i++) {
            const alloc = list[i];
            const span = scale ? this._paintedSpan(alloc, scale, this._spanScratch) : NO_SPAN;
            // Both ends of the interval this bar claims: its time span widened by
            // everything painted around it. With no padding these are its own
            // start and end times, and the layout is purely time-based.
            const start = alloc.startTime - span.lead;
            const end = Math.max(alloc.endTime + span.trail, start);
            if (i > clusterStart && alloc.startTime - maxLead >= clusterMaxEnd) {
                closeCluster(i);
                clusterStart = i;
                laneEnds = [];
                laneHeights = [];
                laneAbove = [];
                laneBelow = [];
                laneEndLowerBound = Infinity;
            }
            let lane;
            if (laneEndLowerBound > start) {
                lane = laneEnds.length;
            } else {
                lane = 0;
                while (lane < laneEnds.length && laneEnds[lane] > start) lane++;
            }
            if (maxLanes > 0 && lane === laneEnds.length && laneEnds.length >= maxLanes) {
                overflow.push(alloc);
                laneInfo.set(alloc, { cluster: null, lane: -1, overflow: true });
                if (end > clusterMaxEnd) clusterMaxEnd = end;
                continue;
            }
            const height = alloc.height && alloc.height > 0 ? alloc.height : 0;
            const clear = clearance ? this._decorationBox(alloc) : NO_CLEARANCE;
            if (lane === laneEnds.length) {
                laneEnds.push(end);
                laneHeights.push(height);
                laneAbove.push(clear.above);
                laneBelow.push(clear.below);
            } else {
                laneEnds[lane] = end;
                if (height > laneHeights[lane]) laneHeights[lane] = height;
                if (clear.above > laneAbove[lane]) laneAbove[lane] = clear.above;
                if (clear.below > laneBelow[lane]) laneBelow[lane] = clear.below;
            }
            if (end < laneEndLowerBound) laneEndLowerBound = end;
            laneInfo.set(alloc, { cluster: null, lane });
            if (end > clusterMaxEnd) clusterMaxEnd = end;
        }
        closeCluster(list.length);
    }

    // Label gap, line height and default icon box, as the decoration layout
    // uses them. The line height is derived from the pixel size in the
    // configured font shorthand: measuring each label's real ascent/descent
    // would tie a whole row's height to the text of individual bars.
    _labelMetrics() {
        let metrics = this._labelMetricsCache;
        if (metrics === null || metrics.gen !== this._decorGen) {
            const c = this.config;
            const match = /(\d*\.?\d+)px/.exec(c.barLabelFont || '');
            const fontSize = match ? parseFloat(match[1]) : DEFAULT_LABEL_FONT_SIZE;
            metrics = this._labelMetricsCache = {
                gen: this._decorGen,
                gap: c.barLabelGap,
                lineHeight: Math.ceil(fontSize * LABEL_LINE_HEIGHT_RATIO),
                iconSize: c.barIconSize
            };
        }
        return metrics;
    }

    // Drawn width of one bar label, in the configured bar-label font. Widths are
    // cached by text: a row of bars is measured once per data load, not once per
    // frame, and labels repeat across bars.
    _labelWidth(text) {
        let widths = this._labelWidths;
        if (widths === null || this._labelWidthsGen !== this._decorGen) {
            widths = this._labelWidths = new Map();
            this._labelWidthsGen = this._decorGen;
        }
        let width = widths.get(text);
        if (width === undefined) {
            const ctx = this._measureCtx;
            // The context is shared with the axis, which measures in its own
            // font, so the font is set per measurement rather than per pass.
            ctx.font = this.config.barLabelFont;
            width = ctx.measureText(text).width;
            widths.set(text, width);
        }
        return width;
    }

    // Pixel extents of one bar's decorations, mirroring how
    // _buildBarDecorations lays them out: how far they reach beyond each edge of
    // the bar (`above`/`below`/`left`/`right`) and how wide the ones centered on
    // the bar are (`width`). All are independent of the zoom, so they are cached
    // per allocation - measuring text once per bar per frame is not affordable.
    //
    // Icons are measured by their box rather than their loaded, aspect-fitted
    // size, so the geometry does not shift as images arrive.
    _decorationBox(alloc) {
        let box = this._decorBoxes.get(alloc);
        if (box === undefined || box.gen !== this._decorGen) {
            box = this._measureDecorations(alloc);
            box.gen = this._decorGen;
            this._decorBoxes.set(alloc, box);
        }
        return box;
    }

    _measureDecorations(alloc) {
        const c = this.config;
        const metrics = this._labelMetrics();
        const gap = metrics.gap;
        const lineHeight = metrics.lineHeight;
        const barHeight = alloc.height && alloc.height > 0 ? alloc.height : c.barHeight;
        // Label widths are only needed to decide whether decorations collide
        // horizontally; without that, the text is never measured.
        const measure = c.stackOnLabelCollision;

        // Running distance from the bar edge to where the next stacked item on
        // that side is drawn, tracking the aboveY/belowY walk in the layout.
        let aboveRun = gap;
        let belowRun = gap;
        let above = 0;
        let below = 0;
        let left = 0;
        let right = 0;
        // Tallest and widest decoration centered on the bar. Anything taller
        // than the bar spills evenly above and below it; anything wider than the
        // bar overhangs both its ends.
        let centerHeight = 0;
        let centerWidth = 0;
        let centerGroup = 0;

        if (alloc.textStart || alloc.textEnd) centerHeight = lineHeight;

        if (alloc.icons) {
            for (const icon of alloc.icons) {
                if (!icon || !icon.source) continue;
                const size = icon.size && icon.size > 0 ? icon.size : metrics.iconSize;
                const pos = String(icon.position || 'start').toLowerCase();
                if (icon.inside) {
                    // Placed against the matching inner edge, so only the part
                    // that does not fit inside the bar needs room.
                    if (pos === 'above') below = Math.max(below, gap + size - barHeight);
                    else if (pos === 'below') above = Math.max(above, gap + size - barHeight);
                    else centerHeight = Math.max(centerHeight, size);
                    centerWidth = Math.max(centerWidth, size);
                } else if (pos === 'above') {
                    above = Math.max(above, aboveRun + size);
                    aboveRun += size + gap;
                    centerWidth = Math.max(centerWidth, size);
                } else if (pos === 'below') {
                    below = Math.max(below, belowRun + size);
                    belowRun += size + gap;
                    centerWidth = Math.max(centerWidth, size);
                } else if (pos === 'center') {
                    centerHeight = Math.max(centerHeight, size);
                    centerGroup += centerGroup === 0 ? size : gap + size;
                } else if (pos === 'end') {
                    centerHeight = Math.max(centerHeight, size);
                    right += gap + size;
                } else {
                    centerHeight = Math.max(centerHeight, size);
                    left += gap + size;
                }
            }
        }

        if (alloc.textAbove) {
            above = Math.max(above, aboveRun + lineHeight);
            if (measure) centerWidth = Math.max(centerWidth, this._labelWidth(alloc.textAbove));
        }
        if (alloc.textBelow) {
            below = Math.max(below, belowRun + lineHeight);
            if (measure) centerWidth = Math.max(centerWidth, this._labelWidth(alloc.textBelow));
        }
        if (alloc.textStart && measure) left += gap + this._labelWidth(alloc.textStart);
        if (alloc.textEnd && measure) right += gap + this._labelWidth(alloc.textEnd);

        const spill = (centerHeight - barHeight) / 2;
        return {
            // Stamped by _decorationBox; declared here so every box has one shape.
            gen: 0,
            above: Math.max(0, above, spill),
            below: Math.max(0, below, spill),
            left,
            right,
            width: Math.max(centerWidth, centerGroup)
        };
    }

    // The span a bar actually paints over, as the time it reaches before its
    // start (`lead`) and past its end (`trail`) at the given scale in pixels per
    // ms. Its delay bars always count; its labels and icons count only at a zoom
    // where they are drawn at all, which is what keeps a zoomed-out row from
    // stacking every bar in it. Written into `out` to keep the lane pass
    // allocation-free.
    _paintedSpan(alloc, scale, out) {
        const startEdge = alloc.startBar && alloc.startBar.duration > 0 ? alloc.startBar.duration : 0;
        const endEdge = alloc.endBar && alloc.endBar.duration > 0 ? alloc.endBar.duration : 0;
        out.lead = startEdge;
        out.trail = endEdge;

        const width = (alloc.endTime - alloc.startTime) * scale;
        if (width < this.config.minBarWidthForLabels) return out;

        const box = this._decorationBox(alloc);
        const overhang = Math.max(0, (box.width - width) / 2) / scale;
        out.lead = Math.max(startEdge + box.left / scale, overhang);
        out.trail = Math.max(endEdge + box.right / scale, overhang);
        return out;
    }

    // Vertical offset (in pixels) of a bar's center from its row's center line.
    // Lanes in a multi-lane cluster are stacked by their actual heights, plus
    // barMargin and the room their labels/icons need between them, and the
    // whole stack is centered on the row, so a cluster mixing bar heights and
    // decorations still lays out without overlap. Offsets are computed once per
    // cluster and cached until the bar layout options change. Single-lane bars
    // sit exactly on the center line (offset 0).
    _stackOffset(alloc) {
        const info = this._laneInfo.get(alloc);
        if (!info || info.overflow) return 0;
        const cluster = info.cluster;
        if (!cluster || cluster.laneHeights.length <= 1) return 0;

        const c = this.config;
        // Compared against a generation counter rather than a composite key
        // built from barHeight/barMargin: this runs once per visible bar per
        // frame, and building a string there allocated on the hottest path.
        const key = this._barLayoutGen;
        if (cluster.key !== key) {
            const heights = cluster.laneHeights;
            const count = heights.length;
            const offsets = new Array(count);
            // The stack is centered by its bars, not by its clearance: the row
            // pads the outermost labels just as it pads a single bar's.
            let y = -this._clusterStackHeight(cluster) / 2;
            for (let i = 0; i < count; i++) {
                if (i > 0) y += c.barMargin + cluster.laneBelow[i - 1] + cluster.laneAbove[i];
                const h = heights[i] || c.barHeight;
                offsets[i] = y + h / 2;
                y += h;
            }
            cluster.offsets = offsets;
            cluster.key = key;
        }
        return cluster.offsets[info.lane];
    }

    // Binary-searches a row's startTime-sorted allocations for the first index
    // that could still intersect a window starting at visStart. Any
    // intersecting allocation has startTime >= visStart - the row's widest
    // effective span, so everything before that lower bound is safely skipped.
    _firstVisibleAllocationIndex(row, visStart) {
        const items = row.items;
        const lowerBound = visStart - row.maxSpanMs;
        let lo = 0;
        let hi = items.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (items[mid].startTime < lowerBound) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        return lo;
    }

    // First index in a startTime-sorted list at which an allocation starting at
    // startTime can be inserted while preserving order.
    _sortedInsertIndex(list, startTime) {
        let lo = 0;
        let hi = list.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (list[mid].startTime <= startTime) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    // Removes one specific allocation from a startTime-sorted list, locating it
    // by its pre-edit start time rather than scanning the whole list.
    _removeFromSorted(list, alloc, prevStartTime) {
        for (let i = this._sortedInsertIndex(list, prevStartTime) - 1;
            i >= 0 && list[i].startTime === prevStartTime; i--) {
            if (list[i] === alloc) {
                list.splice(i, 1);
                return;
            }
        }
        // Fallback if the recorded previous time didn't place it (shouldn't
        // happen, but a missed removal would duplicate the bar).
        const at = list.indexOf(alloc);
        if (at >= 0) list.splice(at, 1);
    }

    // Re-files a single allocation after an edit changed its start time and/or
    // its resource, instead of re-sorting and re-indexing the entire dataset.
    // Only the one or two rows it touches have their lanes recomputed, which is
    // what makes held-down keyboard editing viable on large timelines.
    _reindexAllocation(alloc, prevResourceId, prevStartTime) {
        const changedRow = alloc.resourceId !== prevResourceId;
        const changedTime = alloc.startTime !== prevStartTime;
        if (!changedRow && !changedTime) {
            // Only the end time moved: order is unaffected, but the row's lanes
            // and span bound still depend on it.
            const row = this._rowIndexFor(alloc.resourceId);
            this._widenRowBounds(row, alloc);
            this._assignStackLanes(row.items, row);
            this._recomputeRowMetrics();
            this._reportResourceRows();
            return;
        }

        // Keep the global list ordered by startTime; _indexAllocations relies on
        // that order when it rebuilds every row from scratch.
        if (changedTime) {
            this._removeFromSorted(this.allocations, alloc, prevStartTime);
            this.allocations.splice(
                this._sortedInsertIndex(this.allocations, alloc.startTime), 0, alloc);
        }

        const from = this.allocationsByResource.get(prevResourceId);
        if (from) this._removeFromSorted(from.items, alloc, prevStartTime);

        let to = changedRow ? this.allocationsByResource.get(alloc.resourceId) : from;
        if (!to) {
            to = this._newRowIndex();
            this.allocationsByResource.set(alloc.resourceId, to);
        }
        to.items.splice(this._sortedInsertIndex(to.items, alloc.startTime), 0, alloc);

        // Bounds only widen here. A row whose longest bar just shrank keeps a
        // conservative (still correct, merely wider) scan window until the next
        // full re-index - cheaper than rescanning the row to tighten it.
        this._widenRowBounds(to, alloc);
        this._assignStackLanes(to.items, to);
        if (changedRow && from) this._assignStackLanes(from.items, from);
        this._recomputeRowMetrics();
        this._reportResourceRows();
    }

    // Drops inverted/empty/unknown-resource rows, last-wins on duplicate ids.
    // Warns once per id. Unknown-resource skip is skipped when no resources
    // have been loaded (bare tests that index without a resource list).
    _sanitizeAllocations(list) {
        const known = this._resourceIdSet;
        const haveResources = known && known.size > 0;
        const byId = new Map();
        const order = [];
        for (let i = 0; i < (list || []).length; i++) {
            const a = list[i];
            if (!a || a.id == null || a.id === '') {
                this._warnAllocOnce('', 'skipping allocation with empty id');
                continue;
            }
            if (!(a.endTime > a.startTime)) {
                this._warnAllocOnce(a.id, `skipping allocation '${a.id}' (end <= start)`);
                continue;
            }
            if (haveResources && !known.has(a.resourceId)) {
                this._warnAllocOnce(a.id,
                    `skipping allocation '${a.id}' (unknown resource '${a.resourceId}')`);
                continue;
            }
            if (byId.has(a.id)) {
                this._warnAllocOnce('dup:' + a.id, `duplicate allocation id '${a.id}', keeping last`);
                const prev = byId.get(a.id);
                const idx = order.indexOf(prev);
                if (idx >= 0) order[idx] = a;
                byId.set(a.id, a);
                continue;
            }
            byId.set(a.id, a);
            order.push(a);
        }
        return order;
    }

    _warnAllocOnce(key, message) {
        const k = key || '__empty';
        if (!this._warnedAllocIds) this._warnedAllocIds = new Set();
        if (this._warnedAllocIds.has(k)) return;
        this._warnedAllocIds.add(k);
        console.warn('BlazorResourceTimeline: ' + message);
    }

    _patchAlloc(dest, src) {
        dest.resourceId = src.resourceId;
        dest.startTime = src.startTime;
        dest.endTime = src.endTime;
        dest.color = src.color;
        dest.height = src.height;
        dest.textAbove = src.textAbove;
        dest.textBelow = src.textBelow;
        dest.textStart = src.textStart;
        dest.textEnd = src.textEnd;
        dest.tooltip = src.tooltip;
        dest.startBar = src.startBar;
        dest.endBar = src.endBar;
        dest.icons = src.icons;
        dest.data = src.data;
        dest.locked = src.locked;
        dest.className = src.className;
    }

    setData(resources, start, end, allocations) {
        this._prepareLoadScroll();
        this._windowed = false;
        this.resources = resources || [];
        this._rebuildResourceStructure();
        this.timeRange = { start, end };
        this.allocations = this._sanitizeAllocations(allocations).sort((a, b) => a.startTime - b.startTime);
        this._indexAllocations();
        this.selectedBars.clear();
        this.drag = null;
        this.edit = null;
        this._hideTooltip();
        // Stale focus references would point at allocations no longer present.
        this._focusResource = -1;
        this._focusAlloc = null;
        // A paint is expected as a result of this data change; whenRendered()
        // will wait for it rather than resolving on the next idle frame.
        this._renderPending = true;
        this._relayout();
    }

    // Merges allocations by id (last-wins) without clearing selection or
    // keyboard focus. Replacing a focused bar retargets focus onto the new
    // object; other selected ids stay selected.
    upsertAllocations(batch) {
        if (!batch || !batch.length) return;
        batch = this._sanitizeAllocations(batch);
        if (!batch.length) return;
        const byId = new Map();
        for (let i = 0; i < this.allocations.length; i++) {
            byId.set(this.allocations[i].id, this.allocations[i]);
        }
        const touched = new Set();

        for (let i = 0; i < batch.length; i++) {
            const incoming = batch[i];
            const prev = byId.get(incoming.id);
            if (prev) {
                touched.add(prev.resourceId);
                if (this._focusAlloc === prev) this._focusAlloc = incoming;
                if (this.edit && this.edit.alloc === prev) this.edit.alloc = incoming;
                this._detachAllocation(prev);
            }
            byId.set(incoming.id, incoming);
            this._insertAllocation(incoming);
            touched.add(incoming.resourceId);
        }

        for (const resourceId of touched) {
            const row = this.allocationsByResource.get(resourceId);
            if (row) this._assignStackLanes(row.items, row);
        }
        this._recomputeRowMetrics();
        this._reportResourceRows();
        this._relayout();
    }

    // Drops allocations by id from the index, selection and focus. Other
    // selected/focused bars are left alone. Missing ids are ignored.
    removeAllocations(ids) {
        if (!ids || !ids.length) return;
        const drop = new Set(ids);
        const byId = new Map();
        for (let i = 0; i < this.allocations.length; i++) {
            byId.set(this.allocations[i].id, this.allocations[i]);
        }

        let selectionChanged = false;
        const touched = new Set();
        for (const id of drop) {
            const alloc = byId.get(id);
            if (!alloc) continue;
            touched.add(alloc.resourceId);
            this._detachAllocation(alloc);
            if (this.selectedBars.delete(id)) selectionChanged = true;
            if (this._focusAlloc === alloc) this._focusAlloc = null;
            if (this.edit && this.edit.alloc === alloc) this.edit = null;
        }

        for (const resourceId of touched) {
            const row = this.allocationsByResource.get(resourceId);
            if (row) this._assignStackLanes(row.items, row);
        }
        this._recomputeRowMetrics();
        this._reportResourceRows();
        if (selectionChanged) this._notifySelection();
        this._relayout();
    }

    _detachAllocation(alloc) {
        this._removeFromSorted(this.allocations, alloc, alloc.startTime);
        const row = this.allocationsByResource.get(alloc.resourceId);
        if (row) this._removeFromSorted(row.items, alloc, alloc.startTime);
    }

    _insertAllocation(alloc) {
        this.allocations.splice(this._sortedInsertIndex(this.allocations, alloc.startTime), 0, alloc);
        let row = this.allocationsByResource.get(alloc.resourceId);
        if (!row) {
            row = this._newRowIndex();
            this.allocationsByResource.set(alloc.resourceId, row);
        }
        row.items.splice(this._sortedInsertIndex(row.items, alloc.startTime), 0, alloc);
        this._widenRowBounds(row, alloc);
    }

    // ---- Streaming (chunked) data load ----
    //
    // For very large datasets, the host streams allocations in bounded batches
    // (beginData -> appendAllocations* -> endData) instead of one giant
    // setData call, so a single multi-megabyte interop message doesn't block
    // the SignalR circuit (Blazor Server) or stall the main thread
    // serializing/parsing it all at once. The empty grid is painted up front
    // so structure appears while the batches arrive; sorting and indexing run
    // once at endData.
    beginData(resources, start, end, total) {
        this._prepareLoadScroll();
        // The batches still to arrive will grow the rows that stacking makes
        // taller, so endData re-applies this once the layout has settled.
        this._streamScroll = this._pendingScroll;
        this._windowed = false;
        this.resources = resources || [];
        this._rebuildResourceStructure();
        this.timeRange = { start, end };
        this.allocations = [];
        this.allocationsByResource = new Map();
        this.selectedBars.clear();
        this.drag = null;
        this.edit = null;
        this._hideTooltip();
        this._focusResource = -1;
        this._focusAlloc = null;
        // Accumulates the incoming batches until endData.
        this._loadBuffer = [];
        this._loadExpected = total > 0 ? total : 0;
        // A paint is expected once endData runs; whenRendered() waits for it
        // rather than resolving on the empty-grid frame painted here.
        this._renderPending = true;
        this._relayout();
    }

    appendAllocations(batch) {
        if (!this._loadBuffer || !batch) return;
        // Push individually: spreading a large array into push() can overflow
        // the call stack, and concat would reallocate on every batch.
        for (let i = 0; i < batch.length; i++) {
            this._loadBuffer.push(batch[i]);
        }
    }

    endData() {
        const buffer = this._loadBuffer || [];
        this._loadBuffer = null;
        this._loadExpected = 0;
        this._pendingScroll = this._streamScroll;
        this._streamScroll = null;
        this.allocations = this._sanitizeAllocations(buffer).sort((a, b) => a.startTime - b.startTime);
        this._indexAllocations();
        this._hideTooltip();
        this._focusResource = -1;
        this._focusAlloc = null;
        this._renderPending = true;
        this._relayout();
    }

    clearSelection() {
        this._clearSelectionInternal();
    }

    // Applies new visual options at runtime (e.g. theme, time-zone or renderer
    // change). Dimensions may change, so the layout is recomputed and repainted.
    setOptions(options) {
        const prevRenderer = String(this.config.renderer || 'canvas').toLowerCase();
        const prevBarHeight = this.config.barHeight;
        const prevBarMargin = this.config.barMargin;
        const prevResourceHeight = this.config.resourceHeight;
        const prevNowRefresh = this.config.nowLineRefreshMs;
        const prevMaxStack = this.config.maxStackLanes;
        // The decoration measurements are baked into the lane records when they
        // are built, so everything they are taken from has to force a rebuild.
        const prevClearance = this.config.stackLabelClearance;
        const prevCollision = this.config.stackOnLabelCollision;
        const prevLabelGap = this.config.barLabelGap;
        const prevLabelFont = this.config.barLabelFont;
        const prevIconSize = this.config.barIconSize;
        const prevLabelMinWidth = this.config.minBarWidthForLabels;
        this._applyOptions(options);
        this._rebuildDateFormatters();
        if (this.config.nowLineRefreshMs !== prevNowRefresh) {
            this._stopNowTimer();
            this._startNowTimer();
        }
        // Cached stacking offsets are derived from these two; invalidate them.
        const barLayoutChanged =
            this.config.barHeight !== prevBarHeight || this.config.barMargin !== prevBarMargin;
        // Lane records themselves - their membership, or the clearance they
        // reserve - have to be rebuilt rather than just laid out again.
        const decorMetricsChanged =
            this.config.barHeight !== prevBarHeight
            || this.config.barLabelGap !== prevLabelGap
            || this.config.barLabelFont !== prevLabelFont
            || this.config.barIconSize !== prevIconSize;
        const collisionOn = this.config.stackOnLabelCollision;
        const clearanceOn = this.config.stackLabelClearance;
        if (decorMetricsChanged || collisionOn !== prevCollision) this._decorGen++;
        const lanesChanged =
            this.config.maxStackLanes !== prevMaxStack
            || clearanceOn !== prevClearance
            || collisionOn !== prevCollision
            || ((clearanceOn || prevClearance) && decorMetricsChanged)
            || ((collisionOn || prevCollision) && (
                decorMetricsChanged
                || this.config.minBarWidthForLabels !== prevLabelMinWidth));
        if (barLayoutChanged || lanesChanged) this._barLayoutGen++;
        if (lanesChanged) {
            this._reassignAllLanes();
        } else if (barLayoutChanged) {
            // Tallest cluster per row can change when mixed explicit heights
            // compete with default-height multi-lane stacks.
            this._refreshMaxClusterLanes();
        }
        if (barLayoutChanged || lanesChanged
            || this.config.resourceHeight !== prevResourceHeight) {
            this._recomputeRowMetrics();
            this._reportResourceRows();
        }
        // An explicit pixelsPerHour in the options supersedes any runtime zoom.
        if (options && options.pixelsPerHour != null) {
            this._userPixelsPerHour = null;
        }
        const nextRenderer = String(this.config.renderer || 'canvas').toLowerCase();
        if (nextRenderer !== prevRenderer) {
            this._swapRenderer(nextRenderer);
        }
        if (this._hasTimeRange()) {
            this._relayout();
        } else {
            this.render();
            this._syncAxisSplitterChrome();
        }
    }

    // ---- Zoom (horizontal scale) ----

    // Current effective horizontal scale, in pixels per hour.
    getPixelsPerHour() {
        return this._pixelsPerHour;
    }

    // Sets an explicit scale in pixels per hour (clamped to the configured
    // min/max), keeping the time under the viewport center fixed. Pass null to
    // return to auto (one day per viewport, or the configured value).
    setPixelsPerHour(pph) {
        this._applyZoom(pph, null);
        return this._pixelsPerHour;
    }

    // Multiplies the current scale by a factor, keeping the time under the given
    // surface x (or the viewport center) fixed. Returns the new scale.
    zoomBy(factor, anchorCanvasX) {
        if (!(factor > 0)) return this._pixelsPerHour;
        this._applyZoom(this._pixelsPerHour * factor, anchorCanvasX);
        return this._pixelsPerHour;
    }

    zoomIn(anchorCanvasX) { return this.zoomBy(1.5, anchorCanvasX); }
    zoomOut(anchorCanvasX) { return this.zoomBy(1 / 1.5, anchorCanvasX); }

    // Zooms so exactly `days` days fill the content area (the viewport minus
    // the resource axis), keeping the time under the given surface x (or the
    // viewport center) fixed. The resulting scale is clamped to the configured
    // min/max. days that are not a finite positive number are a no-op.
    zoomToDays(days, anchorCanvasX) {
        if (!(days > 0) || !Number.isFinite(days)) return this._pixelsPerHour;
        this._applyZoom(this._visibleWidth / (days * 24), anchorCanvasX);
        return this._pixelsPerHour;
    }

    // Returns to auto/config scale.
    resetZoom() {
        this._applyZoom(null, null);
        return this._pixelsPerHour;
    }

    // Applies a new scale and repositions the scroll so the anchored time stays
    // under the same x. anchorCanvasX defaults to the viewport center.
    _applyZoom(pph, anchorCanvasX) {
        if (!this._hasTimeRange()) {
            this._userPixelsPerHour = pph;
            this._relayout();
            return;
        }

        const ax = (anchorCanvasX != null)
            ? anchorCanvasX
            : this.config.resourceAxisWidth + this._visibleWidth / 2;
        // Time currently under the anchor (uses the pre-zoom scale and scroll).
        const anchorTime = this.getXToTime(ax);
        // Zooming can change which bars collide, and so how tall their rows are
        // (stackOnLabelCollision). Hold the top row in place across that, or the
        // view would drift vertically as the user zooms.
        const rowAnchor = this._captureRowAnchor();

        this._userPixelsPerHour = pph;
        // Recompute scale + spacer at the new zoom before repositioning.
        this._relayout();
        this._restoreRowAnchor(rowAnchor);

        // Scroll so anchorTime maps back to the same anchor x. Work in virtual
        // space, then map onto the capped native scrollbar. Syncing scrollX and
        // repainting now avoids a one-frame flash at the old scroll position
        // before the async scroll event arrives.
        const contentX = (anchorTime - this.timeRange.start) * this._pixelsPerMs;
        this._setVirtualScrollX(contentX - (ax - this.config.resourceAxisWidth));
        this.render();
        // Zoom changes the visible time span; the loaded window may no longer
        // cover it (especially zooming out), so check for a refetch.
        this._scheduleWindowCheck();
        this._notifyViewIfChanged();
    }

    // ---- On-demand (windowed) data loading ----

    // Puts the engine into windowed mode: resources and overall range are set,
    // an empty grid is painted, and allocations arrive later per fetched window
    // (see getVisibleWindow / applyAllocationWindow / _requestWindowIfNeeded).
    beginWindowed(resources, start, end) {
        this._prepareLoadScroll();
        this.resources = resources || [];
        this._rebuildResourceStructure();
        this.timeRange = { start, end };
        this.allocations = [];
        this.allocationsByResource = new Map();
        this.selectedBars.clear();
        this.drag = null;
        this.edit = null;
        this._hideTooltip();
        this._focusResource = -1;
        this._focusAlloc = null;

        this._windowed = true;
        this._loadedStart = 0;
        this._loadedEnd = 0;
        this._windowRequestId = 0;
        this._windowAppliedId = -1;
        this._windowPending = false;

        this._renderPending = true;
        this._relayout();
    }

    // The time window the engine wants loaded for the current viewport: the
    // visible range widened by windowBufferFactor viewports on each side and
    // clamped to the overall range. Returned as [startMs, endMs] for interop.
    getVisibleWindow() {
        return this._windowFetchRange();
    }

    _windowFetchRange() {
        return this._windowRange(this.config.windowBufferFactor);
    }

    _windowNeededRange() {
        return this._windowRange(this.config.windowRefetchThreshold);
    }

    // Visible time range widened by `factor` viewports on each side, clamped to
    // the overall range.
    _windowRange(factor) {
        const c = this.config;
        const visStart = this.getXToTime(c.resourceAxisWidth);
        const visEnd = this.getXToTime(this._viewportW);
        const widthT = Math.max(1, visEnd - visStart);
        const buf = widthT * (factor || 0);
        const s = Math.max(this.timeRange.start, Math.floor(visStart - buf));
        const e = Math.min(this.timeRange.end, Math.ceil(visEnd + buf));
        return [s, e];
    }

    _scheduleWindowCheck() {
        if (!this._windowed) return;
        clearTimeout(this._windowCheckTimer);
        this._windowCheckTimer = setTimeout(
            () => this._requestWindowIfNeeded(), this.config.windowDebounceMs || 0);
    }

    // Requests a new window from .NET when the loaded window no longer covers the
    // needed (lightly buffered) visible range. Coalesces duplicate requests and
    // tags each with an id so stale responses can be dropped on arrival.
    _requestWindowIfNeeded() {
        if (!this._windowed || !this.dotNetRef || !this._hasTimeRange()) return;

        const [ns, ne] = this._windowNeededRange();
        if (this._loadedStart <= ns && this._loadedEnd >= ne) return; // covered

        const [fs, fe] = this._windowFetchRange();
        // Skip if an outstanding request already covers this fetch window.
        if (this._windowPending && this._pendingStart <= fs && this._pendingEnd >= fe) return;

        const id = ++this._windowRequestId;
        this._windowPending = true;
        this._pendingStart = fs;
        this._pendingEnd = fe;
        this.dotNetRef.invokeMethodAsync('RequestAllocationWindow', id, fs, fe)
            .catch((error) => {
                this._windowPending = false;
                console.error('BlazorResourceTimeline window request failed:', error);
            });
    }

    // Applies a fetched window's allocations. Ignores responses older than the
    // last applied one so a slow fetch can't overwrite a newer window.
    applyAllocationWindow(requestId, allocations, loadedStart, loadedEnd) {
        if (requestId < this._windowAppliedId) return;
        this._windowAppliedId = requestId;
        if (requestId >= this._windowRequestId) this._windowPending = false;

        const incoming = this._sanitizeAllocations(allocations);
        const incomingById = new Map();
        for (let i = 0; i < incoming.length; i++) incomingById.set(incoming[i].id, incoming[i]);

        const next = [];
        const kept = new Set();
        let selectionChanged = false;
        for (let i = 0; i < this.allocations.length; i++) {
            const alloc = this.allocations[i];
            const inc = incomingById.get(alloc.id);
            if (inc) {
                this._patchAlloc(alloc, inc);
                next.push(alloc);
                kept.add(alloc.id);
            } else if (alloc.startTime < loadedEnd && alloc.endTime > loadedStart) {
                next.push(alloc);
                kept.add(alloc.id);
            } else {
                if (this.selectedBars.delete(alloc.id)) selectionChanged = true;
                if (this._focusAlloc === alloc) this._focusAlloc = null;
                if (this.edit && this.edit.alloc === alloc) this.edit = null;
            }
        }
        for (let i = 0; i < incoming.length; i++) {
            if (!kept.has(incoming[i].id)) next.push(incoming[i]);
        }
        next.sort((a, b) => a.startTime - b.startTime);
        this.allocations = next;
        this._indexAllocations();
        this._loadedStart = loadedStart;
        this._loadedEnd = loadedEnd;
        this._hideTooltip();
        if (this.edit && this.edit.alloc && !this.allocations.includes(this.edit.alloc)) {
            this.edit = null;
        }
        if (selectionChanged) this._notifySelection();
        this._renderPending = true;
        this.render();
    }

    // Returns the ids of the currently selected bars, in selection order.
    getSelectedBarIds() {
        return Array.from(this.selectedBars);
    }

    selectBars(ids, additive) {
        const previous = new Set(this.selectedBars);
        const list = ids || [];
        if (!additive) this.selectedBars.clear();
        const present = new Set(this.allocations.map(a => a.id));
        for (let i = 0; i < list.length; i++) {
            if (present.has(list[i])) this.selectedBars.add(list[i]);
        }
        if (list.length) this._selectionAnchorId = list[list.length - 1];
        this._commitSelectionIfChanged(previous);
    }

    scrollToAllocation(id) {
        const alloc = this.allocations.find(a => a.id === id);
        if (!alloc) return false;
        const idx = this._rowIndexById.get(alloc.resourceId);
        if (idx !== undefined) this._scrollRowIntoView(idx);
        this._scrollAllocStartIntoView(alloc);
        this.render();
        this._notifyViewIfChanged();
        return true;
    }

    scrollToResource(id) {
        const idx = this._rowIndexById.get(id);
        if (idx === undefined) return false;
        this._scrollRowIntoView(idx);
        this.render();
        this._notifyViewIfChanged();
        return true;
    }

    _scrollRowIntoView(resourceIndex) {
        const c = this.config;
        const rowTop = this._rowContentTop(resourceIndex);
        const rowBottom = rowTop + this._rowHeight(resourceIndex);
        const viewH = Math.max(this._viewportH - c.timeAxisHeight, 0);
        const viewTop = this.scrollY;
        const viewBottom = viewTop + viewH;
        let sy = this.scrollY;
        if (rowTop < viewTop) sy = rowTop;
        else if (rowBottom > viewBottom) sy = rowBottom - viewH;
        if (sy !== this.scrollY) this._setScrollY(sy);
    }

    _scrollAllocStartIntoView(alloc) {
        const margin = 24;
        const startC = this._timeToContentX(this._effectiveStartTime(alloc));
        const viewLeft = this.scrollX;
        const viewRight = viewLeft + this._visibleWidth;
        if (startC >= viewLeft && startC <= viewRight) return;
        this._setVirtualScrollX(Math.max(0, startC - margin));
    }

    _notifyViewIfChanged() {
        if (!this.dotNetRef || !this._hasTimeRange() || !(this._pixelsPerMs > 0)) return;
        const start = Math.round(this.getXToTime(this.config.resourceAxisWidth));
        const end = Math.round(this.getXToTime(this.config.resourceAxisWidth + this._visibleWidth));
        const pph = this._pixelsPerHour;
        const last = this._lastView;
        if (last && last.start === start && last.end === end && last.pph === pph) return;
        this._lastView = { start, end, pph };
        this.dotNetRef.invokeMethodAsync('OnViewChanged', start, end, pph)
            .catch((error) => console.error('BlazorResourceTimeline view callback failed:', error));
    }

    _copySelection() {
        const ids = this.selectedBars.size
            ? Array.from(this.selectedBars)
            : (this._focusAlloc ? [this._focusAlloc.id] : []);
        this._copyClipboard = ids;
        if (ids.length) this._announce('Copied ' + ids.length);
    }

    async _pasteClipboard() {
        if (!this._copyClipboard.length || !this.dotNetRef) return;
        const offsetMs = this._editStepMs();
        const resourceId = this._focusAlloc
            ? this._focusAlloc.resourceId
            : (this._focusResource >= 0 && this._rows[this._focusResource]
                ? this._rows[this._focusResource].resource.id
                : null);
        let created;
        try {
            created = await this.dotNetRef.invokeMethodAsync(
                'OnAllocationsCopying', this._copyClipboard, offsetMs, resourceId);
        } catch (error) {
            console.error('BlazorResourceTimeline copy callback failed:', error);
            return;
        }
        if (!created || !created.length) return;
        this.upsertAllocations(created);
        this._announce('Pasted ' + created.length);
    }

    async _deleteSelection() {
        const ids = this.selectedBars.size
            ? Array.from(this.selectedBars)
            : (this._focusAlloc ? [this._focusAlloc.id] : []);
        if (!ids.length) return;
        if (this.dotNetRef) {
            try {
                const allowed = await this.dotNetRef.invokeMethodAsync('OnAllocationsDeleting', ids);
                if (allowed === false) {
                    this._announce('Delete refused');
                    return;
                }
            } catch (error) {
                console.error('BlazorResourceTimeline delete callback failed:', error);
                return;
            }
        }
        this.removeAllocations(ids);
        this._announce('Deleted ' + ids.length);
    }

    _weekStartDay() {
        if (this.config.firstDayOfWeek != null && this.config.firstDayOfWeek !== '') {
            return this.config.firstDayOfWeek | 0;
        }
        try {
            const loc = new Intl.Locale(this.config.locale || undefined);
            const info = loc.weekInfo || (typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : null);
            if (info && info.firstDay != null) {
                return info.firstDay === 7 ? 0 : info.firstDay;
            }
        } catch { /* Intl.Locale weekInfo is not everywhere */ }
        return 1;
    }

    // Resolves after the next render's paint completes. Lets the host hide a
    // loading overlay only once the bars are actually on screen. If no render
    // is pending (nothing to draw), resolves on the next frame.
    whenRendered() {
        return new Promise((resolve) => {
            if (this.animationFrame || this._renderPending) {
                this._renderedResolvers.push(resolve);
            } else {
                requestAnimationFrame(() => resolve());
            }
        });
    }

    dispose() {
        // Checked by async callbacks (image loads) that can still fire after
        // teardown and would otherwise touch a disposed engine.
        this._disposed = true;
        if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
        if (this._scrollRaf) cancelAnimationFrame(this._scrollRaf);
        this._stopNowTimer();
        if (this._tooltip) {
            this._tooltip.dispose();
            this._tooltip = null;
        }
        if (this._windowCheckTimer) {
            clearTimeout(this._windowCheckTimer);
            this._windowCheckTimer = null;
        }
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        window.removeEventListener('resize', this._onResize);
        window.removeEventListener('scroll', this._onAnyScroll, { capture: true });
        this.wrapper.removeEventListener('scroll', this._onScroll);
        this.wrapper.removeEventListener('keydown', this._onKeyDown);
        this.wrapper.removeEventListener('focus', this._onFocusIn);
        this.wrapper.removeEventListener('blur', this._onFocusOut);
        this._unbindSurfaceEvents();
        this._teardownAxisSplitter();
        if (this.renderer) {
            this.renderer.dispose();
            this.renderer = null;
        }
        const contentDiv = this._contentDiv || this.wrapper.querySelector('.timeline-content');
        if (contentDiv) contentDiv.remove();
        this._contentDiv = null;
        if (this._liveRegion) {
            this._liveRegion.remove();
            this._liveRegion = null;
        }
        // Detach handlers first: an image still in flight keeps its onload
        // closure - and through it this engine - alive until the load settles.
        for (const img of this.imageCache.values()) {
            img.onload = null;
            img.onerror = null;
        }
        this.imageCache.clear();
        this._flushRenderedResolvers();
        this.dotNetRef = null;
    }
}
