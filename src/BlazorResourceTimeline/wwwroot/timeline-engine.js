// Rendering-agnostic engine for the BlazorResourceTimeline component.
//
// The engine owns all timeline behavior — data and hierarchy indexing,
// scroll/zoom and virtual-scroll math, pointer/keyboard interaction,
// hit-testing, selection, editing, tooltips, on-demand (windowed) loading and
// the .NET interop surface. What it does NOT do is paint: every frame it
// builds a viewport-culled scene (a plain display list, see buildScene) and
// hands it to a pluggable renderer (canvas, SVG or HTML — see ./renderers).
//
// The renderer contract:
//   surface            root element; the engine binds pointer/wheel events to
//                      it and drives its cursor. Created inside the wrapper.
//   resize(cssW, cssH) the viewport size changed; size the surface to match.
//   render(scene)      paint one frame from the scene.
//   dispose()          remove the surface and release resources.
// Renderers receive a host object ({ requestRender, getImage }) for async
// needs such as icon images finishing loading.

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
            resourceHeight: 40,
            timeAxisHeight: 60,
            resourceAxisWidth: 150,
            // Horizontal indent (px) applied per hierarchy depth level to the
            // resource-axis labels, plus room for the group expand/collapse
            // chevron on parent rows.
            resourceIndent: 16,
            dateRowHeight: 22,
            barHeight: 4,
            minBarWidth: 2,
            // Decorations are skipped when the main bar's drawn width falls
            // below this threshold, keeping dense timelines readable.
            minBarWidthForLabels: 24,
            barLabelFont: '11px sans-serif',
            barLabelGap: 3,
            barIconSize: 16,
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
                tooltipText: '#ffffff'
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
            // Horizontal scale in pixels per hour. null means auto: fit exactly
            // one day into the viewport width (the original behavior). An
            // explicit value (or runtime zoom) is clamped to the min/max below.
            pixelsPerHour: null,
            minPixelsPerHour: 0.25,
            maxPixelsPerHour: 1200,
            // Editing. When editable, a bar can be dragged to move it in time
            // (and, if allowResourceChange, onto another resource row), or
            // grabbed near an edge to resize its start/end. Moves/resizes snap
            // to editSnapMinutes (0 = continuous) and never shrink below
            // editMinDurationMinutes. editResizeHandlePx is the grab zone at
            // each end of the main bar.
            editable: false,
            editSnapMinutes: 15,
            editResizeHandlePx: 6,
            editMinDurationMinutes: 5,
            allowResourceChange: true,
            // Hover tooltips. When enabled, hovering a bar (mouse/pen) shows a
            // small popup after tooltipDelayMs. The text is the allocation's
            // `tooltip` field, or a default built from its labels/time range.
            showTooltips: true,
            tooltipDelayMs: 300,
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
            // Which renderer paints the scene: 'canvas' (default), 'svg' or
            // 'html'. Can be switched at runtime via setOptions.
            renderer: 'canvas'
        };

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
        // Persistent index: resourceId -> allocations[] (sorted by startTime).
        // Built once when data is set, reused for rendering and hit-testing.
        this.allocationsByResource = new Map();
        // Longest start/end edge (delay) bar durations and the widest
        // effective span in the data; see _indexAllocations and
        // _visibleAllocationRange for how sorted scans use them.
        this._maxStartEdgeMs = 0;
        this._maxEndEdgeMs = 0;
        this._maxEffectiveSpanMs = 0;

        // Cache of loaded <img> elements keyed by source, used to lay out and
        // draw bar icons. Images load asynchronously; a re-render is triggered
        // once each one is ready. Owned by the engine (not the renderer)
        // because decoration layout needs the natural aspect ratio.
        this.imageCache = new Map();

        // State
        // Selected bars keyed by allocation id, preserving the order in which
        // they were selected. The most recently selected bar is treated as the
        // "primary" selection for single-selection consumers.
        this.selectedBars = new Map();
        this.scrollX = 0;
        this.scrollY = 0;

        // Rubber-band (marquee) drag state. Coordinates are stored in content
        // space (independent of scroll) so the rectangle tracks the data while
        // the user scrolls mid-drag. Only mouse and pen pointers start a drag;
        // touch is reserved for native scrolling (see _touch below).
        this.drag = null;

        // In-progress edit (move/resize) of a single allocation via mouse/pen.
        // null when idle. Holds the original and previewed start/end/resource so
        // the change can be drawn as a ghost and committed (or discarded) on
        // pointer up. See handlePointerDown/Move/Up and _buildGhostScene.
        this.edit = null;

        // Hover tooltip state. The tooltip is a single DOM element (created
        // lazily, appended to <body>, position: fixed) reused across hovers.
        this._tooltipEl = null;
        this._tooltipTimer = null;
        this._tooltipAlloc = null;   // allocation currently described
        this._tooltipContent = '';
        this._tooltipVisible = false;
        this._hoverClientX = 0;
        this._hoverClientY = 0;

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

        // Pending touch interaction. Touch does not start a marquee (so the
        // wrapper can still be panned); a quick, stationary touch is treated as
        // a tap-to-select on release instead.
        this._touch = null;

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

        // Performance helpers
        this.visibleTimeRange = null;
        this.animationFrame = null;
        this._scrollRaf = null;

        // Cached viewport metrics, maintained by the ResizeObserver so the
        // render path never calls getBoundingClientRect (which can force
        // synchronous layout) inside hot loops.
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
        this._virtualWidth = 0;     // full content width in px (uncapped)
        this._virtualScrollMaxX = 0; // max virtual scrollX (virtualWidth - viewport)
        this._scrollScaleX = 1;     // virtual px per real (spacer) px, >= 1

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
        this._onResize = () => this._relayout();
        this._onScroll = () => this._handleScroll();
        this._onPointerDown = (e) => this.handlePointerDown(e);
        this._onPointerMove = (e) => this.handlePointerMove(e);
        this._onPointerUp = (e) => this.handlePointerUp(e);
        this._onPointerCancel = (e) => this.handlePointerCancel(e);
        this._onPointerLeave = () => { this._hideTooltip(); this._setCursor(''); };
        this._onWheel = (e) => this.handleWheel(e);
        this._onContextMenu = (e) => e.preventDefault();
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

        // Keep the "now" indicator honest on idle timelines (e.g. a wall
        // display nobody scrolls): re-render once per minute while the current
        // time falls within the data range. A full redraw is a few
        // milliseconds, negligible at this frequency.
        this._nowTimer = setInterval(() => {
            if (!this._hasTimeRange()) return;
            const now = Date.now();
            if (now < this.timeRange.start || now > this.timeRange.end) return;
            this.render();
        }, 60 * 1000);
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
        this.renderer = new Renderer(this.wrapper, {
            // Icon images finish loading after the frame that laid them out.
            requestRender: () => { if (this._hasTimeRange()) this.render(); },
            getImage: (src) => this._getImage(src)
        });
    }

    // Swaps the active renderer at runtime (setOptions with a new renderer
    // name): the old surface and its event bindings are torn down, the new
    // renderer takes over, and the next layout pass repaints the same scene.
    _swapRenderer(name) {
        this._unbindSurfaceEvents();
        this.renderer.dispose();
        this._createRenderer(name);
        this._bindSurfaceEvents();
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
        if (!options) return;
        const c = this.config;
        for (const key of Object.keys(options)) {
            if (key === 'colors') continue;
            const value = options[key];
            if (value !== null && value !== undefined) c[key] = value;
        }
        if (options.colors) {
            for (const key of Object.keys(options.colors)) {
                const value = options.colors[key];
                if (value !== null && value !== undefined) c.colors[key] = value;
            }
        }
    }

    _setupEventListeners() {
        window.addEventListener('resize', this._onResize);
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
            this._relayout();
        });
        this._resizeObserver.observe(this.wrapper);
    }

    _handleScroll() {
        // Map the native (capped) scroll position onto the virtual content
        // space. _scrollScaleX is 1 unless the content exceeds the spacer cap.
        this.scrollX = this.wrapper.scrollLeft * this._scrollScaleX;
        this.scrollY = this.wrapper.scrollTop;

        // Keep the HTML resource-column overlay aligned with vertical scroll.
        this._syncResourceOverlay();

        // The tooltip is anchored to a screen point that no longer matches the
        // bar once the content scrolls, so dismiss it.
        this._hideTooltip();

        // In windowed mode, scrolling may bring the visible range near the edge
        // of the loaded window; schedule a (debounced) fetch check.
        this._scheduleWindowCheck();

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
                this._paintFrame();
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

        this._updateScale();

        // The surface is sticky-positioned over the viewport; the renderer
        // sizes it (and any backing store) to the viewport dimensions.
        this.renderer.resize(cssW, cssH);

        const totalHeight = this.config.timeAxisHeight + (this._rows.length * this.config.resourceHeight);
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

        // A spacer element defines the scrollable area inside the wrapper.
        let contentDiv = this.wrapper.querySelector('.timeline-content');
        if (!contentDiv) {
            contentDiv = document.createElement('div');
            contentDiv.className = 'timeline-content';
            contentDiv.style.position = 'absolute';
            contentDiv.style.top = '0';
            contentDiv.style.left = '0';
            contentDiv.style.pointerEvents = 'none';
            this.wrapper.appendChild(contentDiv);
        }
        contentDiv.style.width = spacerWidth + 'px';
        contentDiv.style.height = totalHeight + 'px';

        // Keep the virtual offset consistent with the (possibly re-scaled)
        // native scroll position after a resize/zoom/layout change.
        this.scrollX = this.wrapper.scrollLeft * this._scrollScaleX;

        this.render();
    }

    // Sets the horizontal scroll to a virtual offset (in content pixels),
    // mapping it back onto the capped native scrollbar. Keeps this.scrollX and
    // the DOM scrollLeft in sync so an immediate repaint is correct.
    _setVirtualScrollX(virtualX) {
        const clamped = Math.max(0, Math.min(virtualX, this._virtualScrollMaxX));
        this.scrollX = clamped;
        this.wrapper.scrollLeft = this._scrollScaleX > 0 ? clamped / this._scrollScaleX : 0;
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
        return this.config.timeAxisHeight + (resourceIndex * this.config.resourceHeight) - this.scrollY;
    }

    getYToResource(y) {
        const resourceY = y - this.config.timeAxisHeight + this.scrollY;
        if (resourceY < 0) return -1;
        const index = Math.floor(resourceY / this.config.resourceHeight);
        return index >= 0 && index < this._rows.length ? index : -1;
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
        try {
            this.visibleTimeRange = this.calculateVisibleTimeRange();
            if (!this.visibleTimeRange) {
                return;
            }
            this.renderer.render(this.buildScene());
        } catch (error) {
            console.error('BlazorResourceTimeline render error:', error);
        } finally {
            this._flushRenderedResolvers();
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
    // semantic (bars, ticks, rows — not raw rects) so retained-mode renderers
    // (SVG/HTML) can produce meaningful elements, while the canvas renderer
    // paints it immediate-mode. Draw order for renderers:
    //   background -> grid -> bars -> now line -> sticky axes -> marquee -> ghost
    // Bars may extend under the axes; the (opaque) axes are drawn after them,
    // exactly like the original canvas z-order. Marquee and ghost must be
    // clipped to the content area.
    buildScene() {
        const c = this.config;
        const scene = {
            // Renderers read colors/fonts/dimensions from the live config.
            config: c,
            viewport: {
                width: this._viewportW,
                height: this._viewportH,
                axisWidth: c.resourceAxisWidth,
                axisHeight: c.timeAxisHeight,
                dateRowHeight: c.dateRowHeight
            },
            days: [],          // [{ sepX|null, label, labelX, labelY }]
            hourTicks: [],     // [{ x, label, labelY }]
            gridH: [],         // horizontal grid line y positions
            gridV: [],         // vertical grid line x positions
            resourceRows: null, // null when the HTML template overlay is active
            bars: [],
            nowX: null,
            marquee: null,
            ghost: null
        };
        this._buildTimeAxisScene(scene);
        this._buildGridScene(scene);
        this._buildBarsScene(scene);
        this._buildNowScene(scene);
        this._buildResourceAxisScene(scene);
        this._buildMarqueeScene(scene);
        this._buildGhostScene(scene);
        return scene;
    }

    // Top axis row: one label per day, pinned to stay visible while the day is
    // on screen (sticky-header style), with a separator at each midnight
    // boundary. Bottom row: hourly ticks/labels thinned to fit the zoom.
    _buildTimeAxisScene(scene) {
        const c = this.config;
        const startX = c.resourceAxisWidth;
        const visibleEndX = this._viewportW;
        const dateRowHeight = c.dateRowHeight;

        // Day labels are pinned within the day's visible span; measure with
        // the axis font so the pinned position accounts for the text width.
        const ctx = this._measureCtx;
        ctx.font = '12px sans-serif';

        let dayStart = this._startOfZonedDay(this.visibleTimeRange.start);
        while (dayStart <= this.visibleTimeRange.end) {
            const dayEnd = this._nextZonedDay(dayStart);
            const dayStartX = this.getTimeToX(dayStart);
            const dayEndX = this.getTimeToX(dayEnd);

            const day = { sepX: null, label: null, labelX: 0, labelY: dateRowHeight / 2 };

            // Day separator at the start boundary.
            if (dayStartX >= startX && dayStartX <= visibleEndX) {
                day.sepX = dayStartX;
            }

            // Pin the label within the day's visible span (clamped to the axis
            // content area). As the next day's boundary approaches, push the
            // label left so it does not overlap the following day's label.
            const segLeft = Math.max(dayStartX, startX);
            const segRight = Math.min(dayEndX, visibleEndX);
            if (segRight > segLeft) {
                const label = this.formatDateLabel(dayStart);
                const padding = 6;
                const textWidth = ctx.measureText(label).width;
                let labelX = segLeft + padding;
                // Keep the label inside the day's own span.
                if (labelX + textWidth > dayEndX - padding) {
                    labelX = dayEndX - padding - textWidth;
                }
                if (labelX < segLeft + padding) {
                    labelX = segLeft + padding;
                }
                day.label = label;
                day.labelX = labelX;
            }

            if (day.sepX != null || day.label != null) scene.days.push(day);
            dayStart = dayEnd;
        }

        // Hour ticks/labels.
        const step = this._hourStep();
        if (step === 0) return;
        const labelY = (dateRowHeight + c.timeAxisHeight) / 2;
        this._forEachZonedHour(this.visibleTimeRange.start, this.visibleTimeRange.end, (currentTime) => {
            const hour = this._zonedParts(currentTime).hour;
            if (hour % step !== 0) return;
            const x = this.getTimeToX(currentTime);
            if (x >= startX && x <= visibleEndX) {
                scene.hourTicks.push({ x, label: hour.toString().padStart(2, '0'), labelY });
            }
        });
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
        const startX = c.resourceAxisWidth;
        const startY = c.timeAxisHeight;
        const visibleEndX = this._viewportW;
        const visibleEndY = this._viewportH;

        const visibleStart = Math.max(0, Math.floor(this.scrollY / c.resourceHeight) - 1);
        const visibleEnd = Math.min(
            this._rows.length,
            Math.ceil((this.scrollY + this._viewportH - c.timeAxisHeight) / c.resourceHeight) + 1
        );

        for (let i = visibleStart; i <= visibleEnd; i++) {
            const y = this.getResourceToY(i);
            if (y >= startY && y <= visibleEndY) {
                scene.gridH.push(y);
            }
        }

        // Match the hour row's density so vertical lines align with the ticks
        // and don't smear together when zoomed out.
        const step = this._hourStep();
        if (step === 0) return;

        this._forEachZonedHour(this.visibleTimeRange.start, this.visibleTimeRange.end, (currentTime) => {
            if (this._zonedParts(currentTime).hour % step !== 0) return;
            const x = this.getTimeToX(currentTime);
            if (x >= startX && x <= visibleEndX) {
                scene.gridV.push(x);
            }
        });
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

    // Resource-axis rows (labels/chevrons). Omitted entirely (null) when the
    // HTML resource-column template overlay renders them instead; the renderer
    // then only paints the axis background/border.
    _buildResourceAxisScene(scene) {
        const c = this.config;
        if (c.resourceTemplate) return;

        const startY = c.timeAxisHeight;
        const visibleEndY = this._viewportH;
        const indent = c.resourceIndent;
        const visibleStart = Math.max(0, Math.floor(this.scrollY / c.resourceHeight) - 1);
        const visibleEnd = Math.min(
            this._rows.length,
            Math.ceil((this.scrollY + this._viewportH - c.timeAxisHeight) / c.resourceHeight) + 1
        );

        const rows = [];
        for (let i = visibleStart; i < visibleEnd; i++) {
            const y = this.getResourceToY(i);
            if (y < startY || y > visibleEndY) continue;
            const row = this._rows[i];
            rows.push({
                midY: y + c.resourceHeight / 2,
                // Depth reserves room on the left; group rows get a chevron there.
                leftPad: 8 + row.depth * indent,
                name: row.resource.name,
                hasChildren: row.hasChildren,
                collapsed: row.hasChildren && this._collapsed.has(row.resource.id)
            });
        }
        scene.resourceRows = rows;
    }

    _buildBarsScene(scene) {
        const c = this.config;
        const startX = c.resourceAxisWidth;
        const startY = c.timeAxisHeight;
        const visibleEndX = this._viewportW;
        const visibleEndY = this._viewportH;
        const visStart = this.visibleTimeRange.start;
        const visEnd = this.visibleTimeRange.end;

        // Only iterate resources whose row is on screen (vertical culling).
        const firstResource = Math.max(0, Math.floor(this.scrollY / c.resourceHeight) - 1);
        const lastResource = Math.min(
            this._rows.length,
            Math.ceil((this.scrollY + this._viewportH - c.timeAxisHeight) / c.resourceHeight) + 1
        );

        for (let resourceIndex = firstResource; resourceIndex < lastResource; resourceIndex++) {
            const resource = this._rows[resourceIndex].resource;
            const resourceY = this.getResourceToY(resourceIndex);
            if (resourceY + c.resourceHeight < startY || resourceY > visibleEndY) continue;

            const barCenterY = resourceY + c.resourceHeight / 2;
            const resourceAllocations = this.allocationsByResource.get(resource.id);
            if (!resourceAllocations) continue;

            // Binary-search the first allocation that can intersect the visible
            // window instead of linearly skipping everything before it. Any
            // candidate has startTime >= visStart - maxEffectiveSpan, so the
            // scan starts there and breaks once startTime passes the window.
            const firstIndex = this._firstVisibleAllocationIndex(resourceAllocations, visStart);
            for (let i = firstIndex; i < resourceAllocations.length; i++) {
                const alloc = resourceAllocations[i];
                // Time-range culling on the effective span (edge bars
                // included), so delay bars don't pop in/out at the viewport
                // edges. The list is sorted by startTime, so iteration can
                // stop once even the longest possible start edge could no
                // longer reach back into view.
                if (alloc.startTime - this._maxStartEdgeMs > visEnd) break;
                if (this._effectiveEndTime(alloc) < visStart) continue;
                if (this._effectiveStartTime(alloc) > visEnd) continue;

                // Per-bar height (falls back to the configured default), kept
                // vertically centered within the resource row.
                const barHeight = alloc.height && alloc.height > 0 ? alloc.height : c.barHeight;
                const barTop = barCenterY - barHeight / 2;

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

                const node = {
                    id: alloc.id,
                    x: barX,
                    y: barTop,
                    width: barWidth,
                    height: barHeight,
                    color: alloc.color || (isSelected ? c.colors.barSelected : c.colors.bar),
                    selected: isSelected,
                    edges: null,
                    outline: null,
                    focusRing: null,
                    icons: null,
                    labels: null
                };

                // Start edge bar: drawn immediately before the main bar's start.
                if (startEdgeMs) {
                    (node.edges = node.edges || []).push({
                        x: drawStartX, y: barTop,
                        width: Math.max(c.minBarWidth, barX - drawStartX), height: barHeight,
                        color: alloc.startBar.color || c.colors.bar
                    });
                }
                // End edge bar: drawn immediately after the main bar's end.
                if (endEdgeMs) {
                    (node.edges = node.edges || []).push({
                        x: barEndX, y: barTop,
                        width: Math.max(c.minBarWidth, drawEndX - barEndX), height: barHeight,
                        color: alloc.endBar.color || c.colors.bar
                    });
                }

                // The selection outline wraps the full span, edge bars included.
                if (isSelected) {
                    node.outline = {
                        x: drawStartX - 1,
                        y: barTop - 1,
                        width: Math.max(barWidth, drawEndX - drawStartX) + 2,
                        height: barHeight + 2
                    };
                }

                // Keyboard focus ring (dashed, distinct from the solid
                // selection outline), only while the component holds focus so
                // it never lingers after the user clicks away.
                if (this._hasFocus && this._focusAlloc && this._focusAlloc.id === alloc.id) {
                    node.focusRing = {
                        x: drawStartX - 2,
                        y: barTop - 2,
                        width: Math.max(barWidth, drawEndX - drawStartX) + 4,
                        height: barHeight + 4
                    };
                }

                // Per-bar labels and icons (only when present, to keep the
                // common path cheap). Level-of-detail: skip decorations for
                // bars too narrow to sit beside without overlapping their
                // neighbours, which also avoids a flood of unreadable,
                // overlapping text on dense timelines.
                const hasDecorations = alloc.icons?.length || alloc.textAbove || alloc.textBelow || alloc.textStart || alloc.textEnd;
                if (hasDecorations && (barEndX - barX) >= c.minBarWidthForLabels) {
                    this._buildBarDecorations(alloc, node, barX, barEndX, drawStartX, drawEndX, barTop, barCenterY, barHeight, c);
                }

                scene.bars.push(node);
            }
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

        if (alloc.icons && alloc.icons.length) {
            const defaultSize = c.barIconSize;
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
                let x, y;
                if (pos === 'end') {
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
                (node.icons = node.icons || []).push({ source: icon.source, x, y, width: w, height: h });
            }
        }

        const labels = [];
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

        scene.marquee = {
            x: Math.min(x1, x2),
            y: Math.min(y1, y2),
            width: Math.abs(x2 - x1),
            height: Math.abs(y2 - y1)
        };
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
        const barTop = resourceY + c.resourceHeight / 2 - barHeight / 2;
        const x1 = this.getTimeToX(ed.previewStart);
        const x2 = this.getTimeToX(ed.previewEnd);

        scene.ghost = {
            x: x1,
            y: barTop,
            width: Math.max(c.minBarWidth, x2 - x1),
            height: barHeight,
            color: ed.alloc.color || c.colors.barSelected,
            // Time readout above the ghost for precise feedback while dragging.
            label: this._announceDtf
                ? `${this._announceDtf.format(ed.previewStart)} – ${this._announceDtf.format(ed.previewEnd)}`
                : null
        };
    }

    // ---- Zone-aware date/time helpers ----

    // (Re)creates the Intl formatters used to compute and label axis
    // boundaries in the configured time zone (or the viewer's local zone when
    // none is set). Cached because constructing an Intl.DateTimeFormat is
    // comparatively expensive and the axis draws many boundaries per frame.
    _rebuildDateFormatters() {
        const timeZone = this.config.timeZone || undefined;
        // Locale for human-facing labels. The parts formatter stays 'en-US' so
        // its numeric output remains parseable regardless of this setting.
        const locale = this.config.locale || undefined;

        // Numeric wall-clock parts in the zone, used for day/hour math and the
        // hour label. en-US + h23 guarantees parseable 0-23 hour values.
        const partsOpts = {
            hourCycle: 'h23',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        };
        if (timeZone) partsOpts.timeZone = timeZone;
        this._partsDtf = new Intl.DateTimeFormat('en-US', partsOpts);

        // Localized day label; configured (or viewer) locale for i18n, zone for
        // correctness.
        const dateOpts = { weekday: 'short', month: 'short', day: 'numeric' };
        if (timeZone) dateOpts.timeZone = timeZone;
        this._dateLabelDtf = new Intl.DateTimeFormat(locale, dateOpts);

        // Spoken date+time used when announcing a focused bar to screen readers.
        const announceOpts = {
            month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit'
        };
        if (timeZone) announceOpts.timeZone = timeZone;
        this._announceDtf = new Intl.DateTimeFormat(locale, announceOpts);
    }

    // Wall-clock parts of a timestamp in the configured zone.
    _zonedParts(ts) {
        const parts = this._partsDtf.formatToParts(ts);
        const map = {};
        for (const p of parts) {
            if (p.type !== 'literal') map[p.type] = p.value;
        }
        let hour = +map.hour;
        if (hour === 24) hour = 0; // some engines emit '24' at midnight
        return {
            year: +map.year, month: +map.month, day: +map.day,
            hour, minute: +map.minute, second: +map.second
        };
    }

    // Offset (zone - UTC, in ms) in effect at the given instant.
    _zoneOffsetMs(ts) {
        const p = this._zonedParts(ts);
        const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
        return asUtc - Math.floor(ts / 1000) * 1000;
    }

    // Converts a wall-clock time in the configured zone to a UTC timestamp.
    // Two-pass so it resolves correctly across DST offset changes.
    _zonedWallClockToTs(year, month, day, hour, minute, second) {
        const guess = Date.UTC(year, month - 1, day, hour, minute, second);
        const offset1 = this._zoneOffsetMs(guess);
        let ts = guess - offset1;
        const offset2 = this._zoneOffsetMs(ts);
        if (offset2 !== offset1) {
            ts = guess - offset2;
        }
        return ts;
    }

    // Start-of-day (midnight) timestamp for the day containing the given time,
    // in the configured zone.
    _startOfZonedDay(time) {
        const p = this._zonedParts(time);
        return this._zonedWallClockToTs(p.year, p.month, p.day, 0, 0, 0);
    }

    // First midnight strictly after the given day start, in the configured zone.
    // Uses Date.UTC to normalize month/year rollover.
    _nextZonedDay(dayStart) {
        const p = this._zonedParts(dayStart);
        const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
        return this._zonedWallClockToTs(
            next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0);
    }

    // The hour boundary at or after the given hour boundary, in the configured
    // zone. Wall-clock increment (normalized via Date.UTC) so it stays aligned
    // across DST transitions.
    _nextZonedHour(ts) {
        const p = this._zonedParts(ts);
        const next = new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour + 1, 0, 0));
        return this._zonedWallClockToTs(
            next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), next.getUTCHours(), 0, 0);
    }

    // Calls back with each zoned hour boundary in [visibleStart, visibleEnd].
    _forEachZonedHour(visibleStart, visibleEnd, callback) {
        const p = this._zonedParts(visibleStart);
        let ts = this._zonedWallClockToTs(p.year, p.month, p.day, p.hour, 0, 0);
        if (ts < visibleStart) {
            ts = this._nextZonedHour(ts);
        }
        // Guard against pathological non-advancing steps.
        let guard = 0;
        while (ts <= visibleEnd && guard++ < 1000) {
            callback(ts);
            ts = this._nextZonedHour(ts);
        }
    }

    formatDateLabel(ts) {
        return this._dateLabelDtf.format(ts);
    }

    formatTimeLabel(ts) {
        return this._zonedParts(ts).hour.toString().padStart(2, '0');
    }

    // Returns a cached <img> for the given source, creating and loading it on
    // first use. A completed load schedules a re-render so the icon appears as
    // soon as it is ready.
    _getImage(src) {
        let img = this.imageCache.get(src);
        if (!img) {
            img = new Image();
            this.imageCache.set(src, img);
            img.onload = () => {
                if (this._hasTimeRange()) this.render();
            };
            // On error the image stays incomplete (naturalWidth === 0) and is
            // simply skipped when laying out.
            img.onerror = () => { };
            img.src = src;
        }
        return img;
    }

    // ---- Pointer interaction: click, Ctrl/Cmd-click, and marquee drag ----

    // Converts a viewport pointer event to surface-local coordinates.
    _eventToCanvas(e) {
        const rect = this.renderer.surface.getBoundingClientRect();
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
        // Touch is reserved for native panning of the wrapper. Remember the
        // press so a quick, stationary touch can be treated as a tap-to-select
        // on release; do not capture or preventDefault so scrolling still works.
        if (e.pointerType === 'touch') {
            const { x, y } = this._eventToCanvas(e);
            this._touch = { x, y, additive: this._isAdditiveEvent(e) };
            return;
        }

        // Mouse/pen: only react to the primary (left) button.
        if (e.button !== 0) return;

        // Any press ends a hover: hide the tooltip so it doesn't linger over a
        // drag/edit or a fresh selection.
        this._hideTooltip();

        const { x: canvasX, y: canvasY } = this._eventToCanvas(e);

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

        // Editing: a press that lands on a bar begins a move/resize instead of a
        // marquee. A press that misses every bar falls through to marquee below.
        if (this.config.editable) {
            const hit = this._barAt(canvasX, canvasY);
            if (hit) {
                try { this.renderer.surface.setPointerCapture(e.pointerId); } catch { /* ignore */ }
                e.preventDefault();
                const content = this._canvasToContent(canvasX, canvasY);
                this.edit = {
                    pointerId: e.pointerId,
                    mode: this._editZone(hit.alloc, canvasX),
                    alloc: hit.alloc,
                    additive: this._isAdditiveEvent(e),
                    origStart: hit.alloc.startTime,
                    origEnd: hit.alloc.endTime,
                    origResourceIndex: hit.resourceIndex,
                    grabX: content.x,
                    previewStart: hit.alloc.startTime,
                    previewEnd: hit.alloc.endTime,
                    previewResourceIndex: hit.resourceIndex,
                    moved: false
                };
                return;
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
            startX: content.x,
            startY: content.y,
            currentX: content.x,
            currentY: content.y,
            // Snapshot of the selection at drag start, used as the base set
            // when the drag is additive (Ctrl/Cmd held).
            baseSelection: new Map(this.selectedBars),
            moved: false
        };
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
            this._applyMarqueeSelection();
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
                        this._handleClickSelect(x, y, this._touch.additive);
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
                }
                this._touch = null;
            }
            return;
        }

        // Finish an in-progress edit: commit if it actually moved/resized,
        // otherwise treat the press as a plain click (select the bar).
        if (this.edit && e.pointerId === this.edit.pointerId) {
            try { this.renderer.surface.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
            const ed = this.edit;
            this.edit = null;
            if (ed.moved) {
                this._commitEdit(ed);
            } else {
                const { x, y } = this._eventToCanvas(e);
                this._handleClickSelect(x, y, ed.additive);
            }
            return;
        }

        if (!this.drag || e.pointerId !== this.drag.pointerId) return;

        try { this.renderer.surface.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        const drag = this.drag;
        this.drag = null;

        if (drag.moved) {
            // Marquee selection was already applied during the move; finalize it.
            this._applyMarqueeSelection();
            this.render();
            this._notifySelection();
        } else {
            // No meaningful movement: treat as a click / Ctrl-click.
            const { x: canvasX, y: canvasY } = this._eventToCanvas(e);
            this._handleClickSelect(canvasX, canvasY, drag.additive);
        }
    }

    // Aborts an in-progress interaction (e.g. the browser takes the pointer over
    // for scrolling, or the gesture is otherwise interrupted).
    handlePointerCancel(e) {
        this._touch = null;
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
    // resource row; Up/Down move to the nearest allocation in the adjacent
    // row; Home/End jump to the first/last in the row. Enter selects the
    // focused bar (Ctrl/Cmd+Enter or Space toggles it into a multi-selection),
    // Escape clears the selection. PageUp/PageDown pan the time axis, and
    // Ctrl/Cmd +/-/0 zoom. When editing is enabled, Alt+Left/Right move the
    // focused bar, Alt+Up/Down change its resource, Alt+Shift+Left/Right resize
    // the end edge and Alt+Shift+Up/Down resize the start edge. The focused bar
    // is scrolled into view and announced through the live region so
    // screen-reader users can follow along.
    handleKeyDown(e) {
        if (!this._hasTimeRange()) return;
        const mod = e.ctrlKey || e.metaKey;
        const key = e.key;

        if (mod && (key === '+' || key === '=')) { e.preventDefault(); this.zoomIn(); return; }
        if (mod && (key === '-' || key === '_')) { e.preventDefault(); this.zoomOut(); return; }
        if (mod && key === '0') { e.preventDefault(); this.resetZoom(); return; }

        // Editing (Alt held): move/resize the focused bar by one snap step.
        //   Alt+Left/Right       move earlier/later in time
        //   Alt+Shift+Left/Right shrink/grow the end edge (resize)
        //   Alt+Up/Down          move to the previous/next resource row
        if (e.altKey && this.config.editable && this._focusAlloc) {
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
            case 'ArrowLeft': e.preventDefault(); this._moveFocusHorizontal(-1); break;
            case 'ArrowRight': e.preventDefault(); this._moveFocusHorizontal(1); break;
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
        const idx = Math.floor(this.scrollY / this.config.resourceHeight);
        return Math.max(0, Math.min(this._rows.length - 1, idx));
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
        const list = this.allocationsByResource.get(this._rows[this._focusResource].resource.id) || [];
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
        const list = this.allocationsByResource.get(this._rows[this._focusResource].resource.id) || [];
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
        const list = this.allocationsByResource.get(this._rows[this._focusResource].resource.id) || [];
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

    // Selects the focused bar. additive toggles it within a multi-selection;
    // otherwise it replaces the selection with just this bar.
    _toggleSelectFocused(additive) {
        if (!this._focusAlloc) return;
        if (additive) {
            if (this.selectedBars.has(this._focusAlloc.id)) {
                this.selectedBars.delete(this._focusAlloc.id);
            } else {
                this.selectedBars.set(this._focusAlloc.id, this._focusAlloc);
            }
        } else {
            this.selectedBars.clear();
            this.selectedBars.set(this._focusAlloc.id, this._focusAlloc);
        }
        this.render();
        this._notifySelection();
        this._announceFocus();
    }

    // Scrolls the viewport (both axes) so the focused row and bar are visible,
    // syncing scrollX/scrollY so the immediate render is correct rather than
    // waiting for the async scroll event.
    _scrollFocusIntoView() {
        const c = this.config;
        if (this._focusResource >= 0) {
            const rowTop = this._focusResource * c.resourceHeight;
            const rowBottom = rowTop + c.resourceHeight;
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
        const range = `${this._announceDtf.format(a.startTime)} to ${this._announceDtf.format(a.endTime)}`;
        const label = a.textAbove || a.textStart || a.textEnd || a.textBelow || '';
        const selected = this.selectedBars.has(a.id) ? ', selected' : '';
        this._announce(`${resource.name}: ${label ? label + ', ' : ''}${range}${selected}`);
    }

    // Selects (or toggles) the single bar nearest the click point.
    _handleClickSelect(canvasX, canvasY, additive) {
        if (!this._isInContentArea(canvasX, canvasY)) return;

        const resourceIndex = this.getYToResource(canvasY);
        if (resourceIndex === -1) {
            if (!additive) this._clearSelectionInternal();
            this._notifySelection();
            return;
        }

        const resource = this._rows[resourceIndex].resource;

        // Scan this resource's bars. Hit-testing works in pixel space on each
        // bar's drawn extent: the effective span (main bar plus any start/end
        // edge bars) widened by the minimum drawn width and a small tolerance.
        // A bar much shorter than minBarWidth paints more pixels than its time
        // span covers, so a time-space test would miss clicks on those pixels.
        const resourceAllocations = this.allocationsByResource.get(resource.id) || [];
        const tolerance = this.config.hitTolerance;
        const minBarWidth = this.config.minBarWidth;
        // Binary-search the first bar that could reach the click, then scan.
        const clickTime = this.getXToTime(canvasX);
        const firstIndex = this._firstVisibleAllocationIndex(resourceAllocations, clickTime);
        let clickedBar = null;
        let minDistance = Infinity;
        for (let i = firstIndex; i < resourceAllocations.length; i++) {
            const alloc = resourceAllocations[i];
            // Sorted by startTime: once even the longest possible start edge
            // starts right of the click, no later bar can be hit.
            const barX = this.getTimeToX(alloc.startTime);
            if (barX - this._maxStartEdgeMs * this._pixelsPerMs - tolerance > canvasX) break;

            const startPx = this.getTimeToX(this._effectiveStartTime(alloc));
            const barEndX = this.getTimeToX(alloc.endTime);
            const endPx = Math.max(this.getTimeToX(this._effectiveEndTime(alloc)), barX + minBarWidth);
            if (canvasX < startPx - tolerance || canvasX > endPx + tolerance) continue;

            const distance = Math.abs(canvasX - (barX + barEndX) / 2);
            if (distance < minDistance) {
                minDistance = distance;
                clickedBar = alloc;
            }
        }

        if (additive) {
            if (clickedBar) {
                // Toggle membership, Explorer-style.
                if (this.selectedBars.has(clickedBar.id)) {
                    this.selectedBars.delete(clickedBar.id);
                } else {
                    this.selectedBars.set(clickedBar.id, clickedBar);
                }
            }
            // Additive click on empty space leaves the selection unchanged.
        } else {
            this.selectedBars.clear();
            if (clickedBar) {
                this.selectedBars.set(clickedBar.id, clickedBar);
            }
        }

        this.render();
        this._notifySelection();
    }

    // True when a modifier requesting additive selection is held.
    _isAdditiveEvent(e) {
        return e.ctrlKey || e.metaKey;
    }

    // Recomputes the selection from the current marquee rectangle, combining it
    // with the snapshot taken at drag start when the drag is additive.
    _applyMarqueeSelection() {
        if (!this.drag) return;

        const minX = Math.min(this.drag.startX, this.drag.currentX);
        const maxX = Math.max(this.drag.startX, this.drag.currentX);
        const minY = Math.min(this.drag.startY, this.drag.currentY);
        const maxY = Math.max(this.drag.startY, this.drag.currentY);

        const next = this.drag.additive ? new Map(this.drag.baseSelection) : new Map();

        const c = this.config;
        // Only visit rows the marquee actually covers (content-space Y).
        const firstRow = Math.max(0, Math.floor(minY / c.resourceHeight));
        const lastRow = Math.min(this._rows.length - 1, Math.floor(maxY / c.resourceHeight));
        // Left edge of the marquee in time, used to binary-search the first
        // candidate bar per row instead of scanning from the start.
        const minTime = this.timeRange.start + (minX / this._pixelsPerMs);

        for (let resourceIndex = firstRow; resourceIndex <= lastRow; resourceIndex++) {
            const resource = this._rows[resourceIndex].resource;
            const resourceAllocations = this.allocationsByResource.get(resource.id);
            if (!resourceAllocations) continue;

            const firstIndex = this._firstVisibleAllocationIndex(resourceAllocations, minTime);
            for (let i = firstIndex; i < resourceAllocations.length; i++) {
                const alloc = resourceAllocations[i];
                // Sorted by startTime: once even the longest start edge starts
                // right of the marquee, no later bar can be inside it.
                if (this._timeToContentX(alloc.startTime - this._maxStartEdgeMs) > maxX) break;
                // Bar horizontal bounds in content space, including edge bars.
                const barStartX = this._timeToContentX(this._effectiveStartTime(alloc));
                const barEndX = Math.max(barStartX + c.minBarWidth, this._timeToContentX(this._effectiveEndTime(alloc)));
                if (barEndX < minX || barStartX > maxX) continue;
                next.set(alloc.id, alloc);
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
        const list = this.allocationsByResource.get(resource.id) || [];
        const tolerance = this.config.hitTolerance;
        const minBarWidth = this.config.minBarWidth;
        const clickTime = this.getXToTime(canvasX);
        const firstIndex = this._firstVisibleAllocationIndex(list, clickTime);
        let best = null;
        let minDistance = Infinity;
        for (let i = firstIndex; i < list.length; i++) {
            const alloc = list[i];
            const barX = this.getTimeToX(alloc.startTime);
            if (barX - this._maxStartEdgeMs * this._pixelsPerMs - tolerance > canvasX) break;
            const startPx = this.getTimeToX(this._effectiveStartTime(alloc));
            const barEndX = this.getTimeToX(alloc.endTime);
            const endPx = Math.max(this.getTimeToX(this._effectiveEndTime(alloc)), barX + minBarWidth);
            if (canvasX < startPx - tolerance || canvasX > endPx + tolerance) continue;
            const distance = Math.abs(canvasX - (barX + barEndX) / 2);
            if (distance < minDistance) {
                minDistance = distance;
                best = alloc;
            }
        }
        return best ? { alloc: best, resourceIndex } : null;
    }

    // Classifies where on a bar a press landed: near the left/right edge of the
    // main bar (within editResizeHandlePx) resizes that end; anywhere else in
    // the middle moves the whole bar. Bars too narrow for two handles only move.
    _editZone(alloc, canvasX) {
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
        const s = this._editSnapMs();
        return s > 0 ? Math.round(t / s) * s : t;
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
    _keyboardEdit(kind, dir) {
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

        alloc.startTime = newStart;
        alloc.endTime = newEnd;
        if (newIndex !== this._focusResource) alloc.resourceId = this._rows[newIndex].resource.id;

        this.allocations.sort((a, b) => a.startTime - b.startTime);
        this._indexAllocations();
        this._focusResource = newIndex;
        this._scrollFocusIntoView();
        this.render();
        this._announceEdit(alloc, verb);
        this._notifyEdit(alloc);
    }

    _announceEdit(alloc, verb) {
        if (!this._announceDtf) return;
        const range = `${this._announceDtf.format(alloc.startTime)} to ${this._announceDtf.format(alloc.endTime)}`;
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
        } else { // move
            let ns = this._snapTime(ed.origStart + deltaTime);
            let ne = ns + duration;
            if (ns < rangeStart) { ns = rangeStart; ne = ns + duration; }
            if (ne > rangeEnd) { ne = rangeEnd; ns = ne - duration; }
            ed.previewStart = ns;
            ed.previewEnd = ne;
            if (c.allowResourceChange && this._rows.length) {
                const row = Math.floor((canvasY - c.timeAxisHeight + this.scrollY) / c.resourceHeight);
                ed.previewResourceIndex = Math.max(0, Math.min(this._rows.length - 1, row));
            }
        }

        if (ed.previewStart !== ed.origStart ||
            ed.previewEnd !== ed.origEnd ||
            ed.previewResourceIndex !== ed.origResourceIndex) {
            ed.moved = true;
        }
    }

    // Applies a completed edit to the underlying allocation, re-indexes (start
    // time and/or resource may have changed, affecting sort order and the
    // per-resource lists), repaints, and notifies .NET.
    _commitEdit(ed) {
        const alloc = ed.alloc;
        const newResource = this._rows[ed.previewResourceIndex] && this._rows[ed.previewResourceIndex].resource;
        alloc.startTime = ed.previewStart;
        alloc.endTime = ed.previewEnd;
        if (newResource) alloc.resourceId = newResource.id;

        this.allocations.sort((a, b) => a.startTime - b.startTime);
        this._indexAllocations();
        this.render();
        this._notifyEdit(alloc);
    }

    _notifyEdit(alloc) {
        if (!this.dotNetRef) return;
        this.dotNetRef.invokeMethodAsync(
            'OnAllocationEdited', alloc.id, alloc.resourceId, alloc.startTime, alloc.endTime)
            .catch((error) => console.error('BlazorResourceTimeline edit callback failed:', error));
    }

    // Handles a plain hover (no button held): updates the edit cursor (when
    // editable) and the hover tooltip (when enabled) for the bar under the
    // pointer. A single hit-test drives both to keep hover cheap.
    _onHoverMove(e) {
        this._hoverClientX = e.clientX;
        this._hoverClientY = e.clientY;

        const { x, y } = this._eventToCanvas(e);
        const hit = this._isInContentArea(x, y) ? this._barAt(x, y) : null;

        if (this.config.editable) {
            const cursor = hit ? (this._editZone(hit.alloc, x) === 'move' ? 'move' : 'ew-resize') : '';
            this._setCursor(cursor);
        }

        if (!this.config.showTooltips) return;
        if (!hit) { this._hideTooltip(); return; }

        const resource = this._rows[hit.resourceIndex].resource;
        if (hit.alloc !== this._tooltipAlloc) {
            // Moved onto a different bar: rebuild the content and (re)arm the
            // show timer, or swap immediately if a tooltip is already visible.
            this._tooltipAlloc = hit.alloc;
            this._tooltipContent = this._buildTooltip(hit.alloc, resource);
            if (this._tooltipVisible) {
                this._renderTooltip();
            } else {
                clearTimeout(this._tooltipTimer);
                this._tooltipTimer = setTimeout(() => this._renderTooltip(), this.config.tooltipDelayMs || 0);
            }
        } else if (this._tooltipVisible) {
            this._positionTooltip();
        }
    }

    // Builds the tooltip text for an allocation: its explicit `tooltip` field if
    // set, otherwise a default from its label, resource name and time range.
    _buildTooltip(alloc, resource) {
        if (alloc.tooltip) return String(alloc.tooltip);
        const parts = [];
        const label = alloc.textAbove || alloc.textStart || alloc.textEnd || alloc.textBelow;
        if (label) parts.push(label);
        if (resource) parts.push(resource.name);
        if (this._announceDtf) {
            parts.push(`${this._announceDtf.format(alloc.startTime)} – ${this._announceDtf.format(alloc.endTime)}`);
        }
        return parts.join('\n');
    }

    _ensureTooltip() {
        if (this._tooltipEl) return this._tooltipEl;
        const el = document.createElement('div');
        const s = el.style;
        s.position = 'fixed';
        s.zIndex = '2147483647';
        s.pointerEvents = 'none';
        s.maxWidth = '320px';
        s.padding = '6px 8px';
        s.borderRadius = '4px';
        s.font = this.config.barLabelFont;
        s.lineHeight = '1.35';
        s.whiteSpace = 'pre-line';
        s.background = this.config.colors.tooltipBg;
        s.color = this.config.colors.tooltipText;
        s.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.25)';
        s.display = 'none';
        document.body.appendChild(el);
        this._tooltipEl = el;
        return el;
    }

    _renderTooltip() {
        if (!this._tooltipContent) return;
        const el = this._ensureTooltip();
        el.textContent = this._tooltipContent;
        el.style.display = 'block';
        this._tooltipVisible = true;
        this._positionTooltip();
    }

    // Positions the tooltip near the pointer, flipping to the opposite side when
    // it would overflow the viewport.
    _positionTooltip() {
        const el = this._tooltipEl;
        if (!el) return;
        const pad = 12;
        const rect = el.getBoundingClientRect();
        let left = this._hoverClientX + pad;
        let top = this._hoverClientY + pad;
        if (left + rect.width > window.innerWidth - 4) left = this._hoverClientX - rect.width - pad;
        if (top + rect.height > window.innerHeight - 4) top = this._hoverClientY - rect.height - pad;
        el.style.left = Math.max(4, left) + 'px';
        el.style.top = Math.max(4, top) + 'px';
    }

    _hideTooltip() {
        clearTimeout(this._tooltipTimer);
        this._tooltipTimer = null;
        this._tooltipAlloc = null;
        this._tooltipContent = '';
        if (this._tooltipVisible && this._tooltipEl) {
            this._tooltipEl.style.display = 'none';
        }
        this._tooltipVisible = false;
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

    // Notifies .NET of the current selection state. Only the allocation ids
    // cross the interop boundary (the host resolves them against its own
    // data); sending the full objects could exceed Blazor Server's SignalR
    // message size limit for large marquee selections.
    _notifySelection() {
        if (!this.dotNetRef) return;

        const ids = Array.from(this.selectedBars.keys());
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

    // Public toggle so the HTML overlay's chevrons can collapse/expand groups.
    toggleGroup(id) {
        if (!id) return;
        this._toggleGroup(id);
    }

    // Reports the ordered visible rows to .NET (id, name, depth, group state) so
    // the HTML overlay can render one template per row. Cheap: rows are bounded.
    _reportResourceRows() {
        if (!this.dotNetRef || !this.config.resourceTemplate) return;
        const rows = this._rows.map((r) => ({
            id: r.resource.id,
            name: r.resource.name,
            depth: r.depth,
            hasChildren: r.hasChildren,
            collapsed: this._collapsed.has(r.resource.id)
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

    // Scrolls horizontally so the given time is centered in the content area.
    // Returns true if the time is within range and navigation happened.
    scrollToTime(time) {
        if (!this._hasTimeRange() || this._pixelsPerMs === 0) return false;
        if (time < this.timeRange.start || time > this.timeRange.end) return false;

        const contentX = (time - this.timeRange.start) * this._pixelsPerMs;

        // Center the target (virtual space), clamp, then map onto the capped
        // native scrollbar for the smooth scroll.
        const targetVirtual = Math.max(0, Math.min(
            contentX - this._visibleWidth / 2, this._virtualScrollMaxX));
        const targetScrollLeft = this._scrollScaleX > 0 ? targetVirtual / this._scrollScaleX : 0;

        this.wrapper.scrollTo({ left: targetScrollLeft, behavior: 'smooth' });
        return true;
    }

    // Navigates to the current time. Returns true if "now" is within the
    // timeline's data range (and navigation happened), false otherwise.
    goToNow() {
        return this.scrollToTime(Date.now());
    }

    // Rebuilds the resource hierarchy (children map + roots), seeds the initial
    // collapsed set from resource flags, then flattens to the visible rows.
    // Called whenever the resource list is replaced.
    _rebuildResourceStructure() {
        const childrenById = new Map();
        const roots = [];
        const byId = new Map();
        for (const r of this.resources) byId.set(r.id, r);
        for (const r of this.resources) {
            const pid = r.parentId;
            if (pid != null && pid !== r.id && byId.has(pid)) {
                let arr = childrenById.get(pid);
                if (!arr) { arr = []; childrenById.set(pid, arr); }
                arr.push(r);
            } else {
                roots.push(r);
            }
        }
        this._childrenById = childrenById;
        this._resourceRoots = roots;

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
        const visit = (list, depth) => {
            for (const r of list) {
                const kids = this._childrenById.get(r.id);
                const hasChildren = !!(kids && kids.length);
                idIndex.set(r.id, rows.length);
                rows.push({ resource: r, depth, hasChildren });
                if (hasChildren && !this._collapsed.has(r.id)) visit(kids, depth + 1);
            }
        };
        visit(this._resourceRoots, 0);
        this._rows = rows;
        this._rowIndexById = idIndex;
        this._reportResourceRows();
    }

    // Visible-row index at a surface y (content or resource-axis band), or -1.
    _rowAtY(canvasY) {
        const c = this.config;
        if (canvasY < c.timeAxisHeight) return -1;
        const index = Math.floor((canvasY - c.timeAxisHeight + this.scrollY) / c.resourceHeight);
        return index >= 0 && index < this._rows.length ? index : -1;
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
        const index = new Map();
        let maxStartEdgeMs = 0;
        let maxEndEdgeMs = 0;
        let maxEffectiveSpanMs = 0;
        for (const alloc of this.allocations) {
            let list = index.get(alloc.resourceId);
            if (!list) {
                list = [];
                index.set(alloc.resourceId, list);
            }
            list.push(alloc);
            const startEdge = alloc.startBar && alloc.startBar.duration > 0 ? alloc.startBar.duration : 0;
            const endEdge = alloc.endBar && alloc.endBar.duration > 0 ? alloc.endBar.duration : 0;
            if (startEdge > maxStartEdgeMs) maxStartEdgeMs = startEdge;
            if (endEdge > maxEndEdgeMs) maxEndEdgeMs = endEdge;
            const span = (alloc.endTime - alloc.startTime) + startEdge + endEdge;
            if (span > maxEffectiveSpanMs) maxEffectiveSpanMs = span;
        }
        // Each resource's list inherits global sort order, so it is already
        // sorted by startTime.
        this.allocationsByResource = index;
        this._maxStartEdgeMs = maxStartEdgeMs;
        this._maxEndEdgeMs = maxEndEdgeMs;
        this._maxEffectiveSpanMs = maxEffectiveSpanMs;
    }

    // Binary-searches a resource's startTime-sorted allocations for the first
    // index that could still intersect a window starting at visStart. Any
    // intersecting allocation has startTime >= visStart - maxEffectiveSpan, so
    // everything before that lower bound is safely skipped.
    _firstVisibleAllocationIndex(allocations, visStart) {
        const lowerBound = visStart - this._maxEffectiveSpanMs;
        let lo = 0;
        let hi = allocations.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (allocations[mid].startTime < lowerBound) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        return lo;
    }

    setData(resources, start, end, allocations) {
        this._windowed = false;
        this.resources = resources || [];
        this._rebuildResourceStructure();
        this.timeRange = { start, end };
        this.allocations = (allocations || []).slice().sort((a, b) => a.startTime - b.startTime);
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
        this._windowed = false;
        this.resources = resources || [];
        this._rebuildResourceStructure();
        this.timeRange = { start, end };
        this.allocations = [];
        this.allocationsByResource = new Map();
        this._maxStartEdgeMs = 0;
        this._maxEndEdgeMs = 0;
        this._maxEffectiveSpanMs = 0;
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
        this.allocations = buffer.sort((a, b) => a.startTime - b.startTime);
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
        this._applyOptions(options);
        this._rebuildDateFormatters();
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

        this._userPixelsPerHour = pph;
        // Recompute scale + spacer at the new zoom before repositioning.
        this._relayout();

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
    }

    // ---- On-demand (windowed) data loading ----

    // Puts the engine into windowed mode: resources and overall range are set,
    // an empty grid is painted, and allocations arrive later per fetched window
    // (see getVisibleWindow / applyAllocationWindow / _requestWindowIfNeeded).
    beginWindowed(resources, start, end) {
        this.resources = resources || [];
        this._rebuildResourceStructure();
        this.timeRange = { start, end };
        this.allocations = [];
        this.allocationsByResource = new Map();
        this._maxStartEdgeMs = 0;
        this._maxEndEdgeMs = 0;
        this._maxEffectiveSpanMs = 0;
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
        const [s, e] = this._windowFetchRange();
        return [s, e];
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

        this.allocations = (allocations || []).slice().sort((a, b) => a.startTime - b.startTime);
        this._indexAllocations();
        this._loadedStart = loadedStart;
        this._loadedEnd = loadedEnd;
        this._hideTooltip();
        // Focus/edit references may point at bars no longer in the window.
        this._focusAlloc = null;
        this.edit = null;
        this._renderPending = true;
        this.render();
    }

    // Returns the ids of the currently selected bars, in selection order.
    getSelectedBarIds() {
        return Array.from(this.selectedBars.keys());
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
        if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
        if (this._scrollRaf) cancelAnimationFrame(this._scrollRaf);
        if (this._nowTimer) {
            clearInterval(this._nowTimer);
            this._nowTimer = null;
        }
        if (this._tooltipTimer) {
            clearTimeout(this._tooltipTimer);
            this._tooltipTimer = null;
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
        this.wrapper.removeEventListener('scroll', this._onScroll);
        this.wrapper.removeEventListener('keydown', this._onKeyDown);
        this.wrapper.removeEventListener('focus', this._onFocusIn);
        this.wrapper.removeEventListener('blur', this._onFocusOut);
        this._unbindSurfaceEvents();
        if (this.renderer) {
            this.renderer.dispose();
            this.renderer = null;
        }
        const contentDiv = this.wrapper.querySelector('.timeline-content');
        if (contentDiv) contentDiv.remove();
        if (this._liveRegion) {
            this._liveRegion.remove();
            this._liveRegion = null;
        }
        if (this._tooltipEl) {
            this._tooltipEl.remove();
            this._tooltipEl = null;
        }
        this.imageCache.clear();
        this._flushRenderedResolvers();
        this.dotNetRef = null;
    }
}
