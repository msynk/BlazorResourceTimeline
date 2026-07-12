// Canvas-based renderer for the BlazorResourceTimeline Blazor component.
// Exposes a small factory used by the .razor component through JS interop.

export function createTimeline(canvasId, dotNetRef) {
    return new BlazorResourceTimeline(canvasId, dotNetRef);
}

class BlazorResourceTimeline {
    constructor(canvasId, dotNetRef) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        this.wrapper = this.canvas.parentElement;
        this.dotNetRef = dotNetRef || null;

        // Visual configuration
        this.config = {
            resourceHeight: 40,
            timeAxisHeight: 60,
            resourceAxisWidth: 150,
            dateRowHeight: 22,
            barHeight: 4,
            minBarWidth: 2,
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
                selectionBorder: '#4dabf7'
            },
            // Minimum pointer movement (px) before a press is treated as a
            // rubber-band drag rather than a click.
            dragThreshold: 4
        };

        // Data
        this.resources = [];
        this.timeRange = { start: null, end: null };
        this.consumptions = [];
        // Persistent index: resourceId -> consumptions[] (sorted by startTime).
        // Built once when data is set, reused for rendering and hit-testing.
        this.consumptionsByResource = new Map();

        // Cache of loaded <img> elements keyed by source, used to draw bar
        // icons on the canvas. Images load asynchronously; a re-render is
        // triggered once each one is ready.
        this.imageCache = new Map();

        // State
        // Selected bars keyed by consumption id, preserving the order in which
        // they were selected. The most recently selected bar is treated as the
        // "primary" selection for single-selection consumers.
        this.selectedBars = new Map();
        this.scrollX = 0;
        this.scrollY = 0;

        // Rubber-band (marquee) drag state. Coordinates are stored in content
        // space (independent of scroll) so the rectangle tracks the data while
        // the user scrolls mid-drag.
        this.drag = null;

        // Performance helpers
        this.visibleTimeRange = null;
        this.animationFrame = null;
        this._scrollRaf = null;

        // Resolvers waiting for the next completed paint (see whenRendered).
        this._renderedResolvers = [];
        this._renderPending = false;

        // Bound handlers so we can remove them on dispose
        this._onResize = () => this.resizeCanvas();
        this._onScroll = () => this._handleScroll();
        this._onMouseDown = (e) => this.handleMouseDown(e);
        this._onMouseMove = (e) => this.handleMouseMove(e);
        this._onMouseUp = (e) => this.handleMouseUp(e);
        this._onContextMenu = (e) => e.preventDefault();

        this._setupEventListeners();
    }

    _setupEventListeners() {
        window.addEventListener('resize', this._onResize);
        this.wrapper.addEventListener('scroll', this._onScroll, { passive: true });
        this.canvas.addEventListener('mousedown', this._onMouseDown);
        // Move/up are bound on window so a drag continues to track even when the
        // pointer leaves the canvas, and completes on release anywhere.
        window.addEventListener('mousemove', this._onMouseMove);
        window.addEventListener('mouseup', this._onMouseUp);
        this.canvas.addEventListener('contextmenu', this._onContextMenu);
    }

    _handleScroll() {
        this.scrollX = this.wrapper.scrollLeft;
        this.scrollY = this.wrapper.scrollTop;
        this.updateCanvasPosition();

        if (this._scrollRaf) {
            cancelAnimationFrame(this._scrollRaf);
        }
        this._scrollRaf = requestAnimationFrame(() => {
            if (this._hasData()) {
                this.render();
            }
            this._scrollRaf = null;
        });
    }

    _hasData() {
        return this.resources.length > 0 && this.timeRange.start && this.timeRange.end;
    }

    setupCanvas() {
        this.resizeCanvas();
    }

    resizeCanvas() {
        if (!this._hasData()) {
            return;
        }

        const rect = this.wrapper.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
            requestAnimationFrame(() => this.resizeCanvas());
            return;
        }

        const viewportWidth = rect.width;
        const viewportHeight = rect.height;

        const totalHeight = this.config.timeAxisHeight + (this.resources.length * this.config.resourceHeight);
        const timeSpan = this.timeRange.end - this.timeRange.start;
        const visibleWidth = Math.max(rect.width - this.config.resourceAxisWidth, 100);

        // One viewport width shows exactly one day.
        const oneDay = 24 * 60 * 60 * 1000;
        const totalDays = timeSpan / oneDay;
        const totalWidth = this.config.resourceAxisWidth + (totalDays * visibleWidth);

        if (this.canvas.width !== viewportWidth || this.canvas.height !== viewportHeight) {
            this.canvas.width = viewportWidth;
            this.canvas.height = viewportHeight;
        }

        this.updateCanvasPosition();

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
        contentDiv.style.width = totalWidth + 'px';
        contentDiv.style.height = totalHeight + 'px';

        this.render();
    }

    updateCanvasPosition() {
        const wrapperRect = this.wrapper.getBoundingClientRect();
        this.canvas.style.position = 'sticky';
        this.canvas.style.top = '0';
        this.canvas.style.left = '0';
        this.canvas.style.width = wrapperRect.width + 'px';
        this.canvas.style.height = wrapperRect.height + 'px';
    }

    getTimeToX(time) {
        if (!this.timeRange.start || !this.timeRange.end) return 0;
        const wrapperRect = this.wrapper.getBoundingClientRect();
        const visibleWidth = wrapperRect.width - this.config.resourceAxisWidth;
        if (visibleWidth <= 0) return 0;

        const pixelsPerHour = visibleWidth / 24;
        const pixelsPerMs = pixelsPerHour / (60 * 60 * 1000);
        const contentX = (time - this.timeRange.start) * pixelsPerMs;
        return this.config.resourceAxisWidth + contentX - this.scrollX;
    }

    getXToTime(x) {
        if (!this.timeRange.start || !this.timeRange.end) return 0;
        const wrapperRect = this.wrapper.getBoundingClientRect();
        const visibleWidth = wrapperRect.width - this.config.resourceAxisWidth;
        if (visibleWidth <= 0) return this.timeRange.start;

        const pixelsPerHour = visibleWidth / 24;
        const msPerPixel = (60 * 60 * 1000) / pixelsPerHour;
        const contentX = (x - this.config.resourceAxisWidth) + this.scrollX;
        return this.timeRange.start + contentX * msPerPixel;
    }

    getResourceToY(resourceIndex) {
        return this.config.timeAxisHeight + (resourceIndex * this.config.resourceHeight) - this.scrollY;
    }

    getYToResource(y) {
        const resourceY = y - this.config.timeAxisHeight + this.scrollY;
        if (resourceY < 0) return -1;
        const index = Math.floor(resourceY / this.config.resourceHeight);
        return index >= 0 && index < this.resources.length ? index : -1;
    }

    calculateVisibleTimeRange() {
        if (!this.timeRange.start || !this.timeRange.end) return null;

        const wrapperRect = this.wrapper.getBoundingClientRect();
        const visibleWidth = wrapperRect.width - this.config.resourceAxisWidth;
        const pixelsPerHour = visibleWidth / 24;
        const msPerPixel = (60 * 60 * 1000) / pixelsPerHour;

        const startTime = this.timeRange.start + (this.scrollX * msPerPixel);
        const endTime = startTime + (visibleWidth * msPerPixel);

        const padding = (endTime - startTime) * 0.1;
        return {
            start: Math.max(this.timeRange.start, startTime - padding),
            end: Math.min(this.timeRange.end, endTime + padding)
        };
    }

    render() {
        if (!this._hasData() || this.canvas.width === 0 || this.canvas.height === 0) {
            return;
        }

        if (this.animationFrame) {
            cancelAnimationFrame(this.animationFrame);
        }

        this.animationFrame = requestAnimationFrame(() => {
            try {
                this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
                this.visibleTimeRange = this.calculateVisibleTimeRange();
                if (!this.visibleTimeRange) {
                    this.animationFrame = null;
                    this._flushRenderedResolvers();
                    return;
                }

                // z-order: background -> grid -> bars -> now line -> sticky axes
                this.drawBackground();
                this.drawGridLines();
                this.drawConsumptionBars();
                this.drawNowLine();
                this.drawTimeAxis();
                this.drawResourceAxis();
                this.drawSelectionRect();
            } catch (error) {
                console.error('BlazorResourceTimeline render error:', error);
            } finally {
                this.animationFrame = null;
                this._flushRenderedResolvers();
            }
        });
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

    drawBackground() {
        const wrapperRect = this.wrapper.getBoundingClientRect();
        const c = this.config;
        const contentX = c.resourceAxisWidth;
        const contentY = c.timeAxisHeight;
        const contentWidth = wrapperRect.width - c.resourceAxisWidth;
        const contentHeight = wrapperRect.height - c.timeAxisHeight;

        this.ctx.fillStyle = c.colors.contentBg;
        this.ctx.fillRect(contentX, contentY, contentWidth, contentHeight);

        this.ctx.fillStyle = c.colors.axisBg;
        this.ctx.fillRect(0, c.timeAxisHeight, c.resourceAxisWidth, contentHeight);
        this.ctx.fillRect(contentX, 0, contentWidth, c.timeAxisHeight);
    }

    drawTimeAxis() {
        const c = this.config;
        const axisHeight = c.timeAxisHeight;
        const dateRowHeight = c.dateRowHeight;
        const hourRowTop = dateRowHeight;
        const startX = c.resourceAxisWidth;
        const wrapperRect = this.wrapper.getBoundingClientRect();
        const visibleEndX = wrapperRect.width;

        this.ctx.fillStyle = c.colors.axisBg;
        this.ctx.fillRect(startX, 0, visibleEndX - startX, axisHeight);

        // Bottom border of the whole axis.
        this.ctx.strokeStyle = c.colors.axisBorder;
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(startX, axisHeight);
        this.ctx.lineTo(visibleEndX, axisHeight);
        this.ctx.stroke();

        // Divider between the date row and the hour row.
        this.ctx.strokeStyle = c.colors.axisBorder;
        this.ctx.beginPath();
        this.ctx.moveTo(startX, hourRowTop);
        this.ctx.lineTo(visibleEndX, hourRowTop);
        this.ctx.stroke();

        if (!this.visibleTimeRange) return;

        this.drawDateRow(startX, visibleEndX, dateRowHeight);
        this.drawHourRow(startX, visibleEndX, hourRowTop, axisHeight);
    }

    // Top row: one label per day, pinned to stay visible while the day is on
    // screen, with a separator drawn at each midnight boundary.
    drawDateRow(startX, visibleEndX, dateRowHeight) {
        const c = this.config;
        const ctx = this.ctx;

        // First midnight at or before the visible start.
        let dayStart = this.startOfLocalDay(this.visibleTimeRange.start);

        ctx.font = '12px sans-serif';
        ctx.textBaseline = 'middle';

        while (dayStart <= this.visibleTimeRange.end) {
            const dayEnd = this.nextLocalDay(dayStart);
            const dayStartX = this.getTimeToX(dayStart);
            const dayEndX = this.getTimeToX(dayEnd);

            // Day separator at the start boundary.
            if (dayStartX >= startX && dayStartX <= visibleEndX) {
                ctx.strokeStyle = c.colors.axisBorder;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(dayStartX, 0);
                ctx.lineTo(dayStartX, dateRowHeight);
                ctx.stroke();
            }

            // Pin the label within the day's visible span so it stays on screen
            // (clamped to the axis content area), like a sticky header. As the
            // next day's boundary approaches, push the label left so it does not
            // overlap the following day's label.
            const segLeft = Math.max(dayStartX, startX);
            const segRight = Math.min(dayEndX, visibleEndX);
            if (segRight > segLeft) {
                const label = this.formatDateLabel(new Date(dayStart));
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
                ctx.fillStyle = c.colors.dateLabel;
                ctx.textAlign = 'left';
                ctx.fillText(label, labelX, dateRowHeight / 2);
            }

            dayStart = dayEnd;
        }
    }

    // Bottom row: hourly ticks and hour-of-day labels.
    drawHourRow(startX, visibleEndX, rowTop, axisHeight) {
        const c = this.config;
        const ctx = this.ctx;
        const labelY = (rowTop + axisHeight) / 2;
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        this.forEachLocalHour(this.visibleTimeRange.start, this.visibleTimeRange.end, (currentTime) => {
            const x = this.getTimeToX(currentTime);
            if (x >= startX && x <= visibleEndX) {
                ctx.strokeStyle = c.colors.tick;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(x, axisHeight - 8);
                ctx.lineTo(x, axisHeight);
                ctx.stroke();

                ctx.fillStyle = c.colors.label;
                ctx.fillText(this.formatTimeLabel(new Date(currentTime)), x, labelY);
            }
        });
    }

    // Local-midnight timestamp for the day containing the given time.
    startOfLocalDay(time) {
        const d = new Date(time);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    }

    // First local-midnight strictly after the given day start.
    nextLocalDay(dayStart) {
        const d = new Date(dayStart);
        d.setDate(d.getDate() + 1);
        return d.getTime();
    }

    // Calls back with each local hour boundary in [visibleStart, visibleEnd].
    // Uses setHours so DST transitions stay aligned with wall-clock hours.
    forEachLocalHour(visibleStart, visibleEnd, callback) {
        const d = new Date(visibleStart);
        d.setMinutes(0, 0, 0);
        if (d.getTime() < visibleStart) {
            d.setHours(d.getHours() + 1);
        }
        while (d.getTime() <= visibleEnd) {
            callback(d.getTime());
            d.setHours(d.getHours() + 1);
        }
    }

    formatDateLabel(date) {
        return date.toLocaleDateString(undefined, {
            weekday: 'short',
            month: 'short',
            day: 'numeric'
        });
    }

    formatTimeLabel(date) {
        return date.getHours().toString().padStart(2, '0');
    }

    drawResourceAxis() {
        const c = this.config;
        const axisWidth = c.resourceAxisWidth;
        const startY = c.timeAxisHeight;
        const wrapperRect = this.wrapper.getBoundingClientRect();
        const visibleEndY = wrapperRect.height;

        this.ctx.fillStyle = c.colors.axisBg;
        this.ctx.fillRect(0, startY, axisWidth, visibleEndY - startY);

        this.ctx.strokeStyle = c.colors.axisBorder;
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(axisWidth, startY);
        this.ctx.lineTo(axisWidth, visibleEndY);
        this.ctx.stroke();

        this.ctx.fillStyle = c.colors.label;
        this.ctx.font = '13px sans-serif';
        this.ctx.textAlign = 'right';
        this.ctx.textBaseline = 'middle';

        const visibleStart = Math.max(0, Math.floor(this.scrollY / c.resourceHeight) - 1);
        const visibleEnd = Math.min(
            this.resources.length,
            Math.ceil((this.scrollY + wrapperRect.height - c.timeAxisHeight) / c.resourceHeight) + 1
        );

        for (let i = visibleStart; i < visibleEnd; i++) {
            const y = this.getResourceToY(i);
            if (y >= startY && y <= visibleEndY) {
                this.ctx.fillText(this.resources[i].name, axisWidth - 10, y + c.resourceHeight / 2);
            }
        }
    }

    drawGridLines() {
        const c = this.config;
        const startX = c.resourceAxisWidth;
        const startY = c.timeAxisHeight;
        const wrapperRect = this.wrapper.getBoundingClientRect();
        const visibleEndX = wrapperRect.width;
        const visibleEndY = wrapperRect.height;

        this.ctx.strokeStyle = c.colors.grid;
        this.ctx.lineWidth = 1;

        const visibleStart = Math.max(0, Math.floor(this.scrollY / c.resourceHeight) - 1);
        const visibleEnd = Math.min(
            this.resources.length,
            Math.ceil((this.scrollY + wrapperRect.height - c.timeAxisHeight) / c.resourceHeight) + 1
        );

        for (let i = visibleStart; i <= visibleEnd; i++) {
            const y = this.getResourceToY(i);
            if (y >= startY && y <= visibleEndY) {
                this.ctx.beginPath();
                this.ctx.moveTo(startX, y);
                this.ctx.lineTo(visibleEndX, y);
                this.ctx.stroke();
            }
        }

        if (!this.visibleTimeRange) return;

        this.forEachLocalHour(this.visibleTimeRange.start, this.visibleTimeRange.end, (currentTime) => {
            const x = this.getTimeToX(currentTime);
            if (x >= startX && x <= visibleEndX) {
                this.ctx.beginPath();
                this.ctx.moveTo(x, startY);
                this.ctx.lineTo(x, visibleEndY);
                this.ctx.stroke();
            }
        });
    }

    // Vertical indicator at the current time, drawn only when "now" falls
    // within the timeline's data range and the visible viewport.
    drawNowLine() {
        const c = this.config;
        const now = Date.now();
        if (now < this.timeRange.start || now > this.timeRange.end) return;

        const startX = c.resourceAxisWidth;
        const startY = c.timeAxisHeight;
        const wrapperRect = this.wrapper.getBoundingClientRect();
        const visibleEndX = wrapperRect.width;
        const visibleEndY = wrapperRect.height;

        const x = this.getTimeToX(now);
        if (x < startX || x > visibleEndX) return;

        this.ctx.strokeStyle = c.colors.now;
        this.ctx.lineWidth = 2;
        this.ctx.beginPath();
        this.ctx.moveTo(x, startY);
        this.ctx.lineTo(x, visibleEndY);
        this.ctx.stroke();

        // Small triangular marker at the top of the line.
        this.ctx.fillStyle = c.colors.now;
        this.ctx.beginPath();
        this.ctx.moveTo(x - 4, startY);
        this.ctx.lineTo(x + 4, startY);
        this.ctx.lineTo(x, startY + 5);
        this.ctx.closePath();
        this.ctx.fill();
    }

    drawConsumptionBars() {
        if (!this.visibleTimeRange) return;

        const c = this.config;
        const startX = c.resourceAxisWidth;
        const startY = c.timeAxisHeight;
        const wrapperRect = this.wrapper.getBoundingClientRect();
        const visibleEndX = wrapperRect.width;
        const visibleEndY = wrapperRect.height;
        const visStart = this.visibleTimeRange.start;
        const visEnd = this.visibleTimeRange.end;

        // Only iterate resources whose row is on screen (vertical culling).
        const firstResource = Math.max(0, Math.floor(this.scrollY / c.resourceHeight) - 1);
        const lastResource = Math.min(
            this.resources.length,
            Math.ceil((this.scrollY + wrapperRect.height - c.timeAxisHeight) / c.resourceHeight) + 1
        );

        for (let resourceIndex = firstResource; resourceIndex < lastResource; resourceIndex++) {
            const resource = this.resources[resourceIndex];
            const resourceY = this.getResourceToY(resourceIndex);
            if (resourceY + c.resourceHeight < startY || resourceY > visibleEndY) continue;

            const barCenterY = resourceY + c.resourceHeight / 2;
            const resourceConsumptions = this.consumptionsByResource.get(resource.id);
            if (!resourceConsumptions) continue;

            for (const cons of resourceConsumptions) {
                // Time-range culling (list is sorted by startTime).
                if (cons.endTime < visStart) continue;
                if (cons.startTime > visEnd) break;

                // Per-bar height (falls back to the configured default), kept
                // vertically centered within the resource row.
                const barHeight = cons.height && cons.height > 0 ? cons.height : c.barHeight;
                const barTop = barCenterY - barHeight / 2;

                const barX = this.getTimeToX(cons.startTime);
                const barEndX = this.getTimeToX(cons.endTime);

                // Edge (delay) bars extend the drawn span before/after the main
                // bar, so account for them when culling and when drawing.
                const startEdgeMs = cons.startBar && cons.startBar.duration > 0 ? cons.startBar.duration : 0;
                const endEdgeMs = cons.endBar && cons.endBar.duration > 0 ? cons.endBar.duration : 0;
                const drawStartX = startEdgeMs ? this.getTimeToX(cons.startTime - startEdgeMs) : barX;
                const drawEndX = endEdgeMs ? this.getTimeToX(cons.endTime + endEdgeMs) : barEndX;
                if (drawEndX < startX || drawStartX > visibleEndX) continue;

                // Start edge bar: drawn immediately before the main bar's start.
                if (startEdgeMs) {
                    const edgeWidth = Math.max(c.minBarWidth, barX - drawStartX);
                    this.ctx.fillStyle = cons.startBar.color || c.colors.bar;
                    this.ctx.fillRect(drawStartX, barTop, edgeWidth, barHeight);
                }
                // End edge bar: drawn immediately after the main bar's end.
                if (endEdgeMs) {
                    const edgeWidth = Math.max(c.minBarWidth, drawEndX - barEndX);
                    this.ctx.fillStyle = cons.endBar.color || c.colors.bar;
                    this.ctx.fillRect(barEndX, barTop, edgeWidth, barHeight);
                }

                const barWidth = Math.max(c.minBarWidth, barEndX - barX);
                const isSelected = this.selectedBars.has(cons.id);
                if (isSelected) {
                    this.ctx.fillStyle = cons.color || c.colors.barSelected;
                    this.ctx.fillRect(barX, barTop, barWidth, barHeight);
                    // The selection outline wraps the full span, edge bars included.
                    const selLeft = drawStartX - 1;
                    const selWidth = Math.max(barWidth, drawEndX - drawStartX) + 2;
                    this.ctx.strokeStyle = c.colors.barSelectedBorder;
                    this.ctx.lineWidth = 2;
                    this.ctx.strokeRect(selLeft, barTop - 1, selWidth, barHeight + 2);
                } else {
                    this.ctx.fillStyle = cons.color || c.colors.bar;
                    this.ctx.fillRect(barX, barTop, barWidth, barHeight);
                }

                // Per-bar labels and icons (only when present, to keep the
                // common path cheap). Start/end decorations sit outside the
                // full span (edge bars included).
                if (cons.icons?.length || cons.textAbove || cons.textBelow || cons.textStart || cons.textEnd) {
                    this._drawBarDecorations(cons, barX, barEndX, drawStartX, drawEndX, barTop, barCenterY, barHeight, c);
                }
            }
        }
    }

    // Renders the optional icons and labels around a single bar.
    // Label positions:
    //   above  -> centered over the main bar, baseline just above it
    //   below  -> centered under the main bar, baseline just below it
    //   start  -> right-aligned, ending just before the full span's left edge
    //   end    -> left-aligned, starting just after the full span's right edge
    // Icons share these anchor positions and are drawn first; labels are then
    // pushed outward so they never overlap an icon at the same position.
    // spanStartX/spanEndX are the outer edges of the drawn bar including any
    // start/end edge bars, so start/end decorations never overlap them.
    _drawBarDecorations(cons, barX, barEndX, spanStartX, spanEndX, barTop, barCenterY, barHeight, c) {
        const ctx = this.ctx;
        const gap = c.barLabelGap;
        const barBottom = barTop + barHeight;
        const barCenterX = (barX + barEndX) / 2;

        // Outer edges, advanced as decorations are placed so multiple items at
        // the same position stack without overlapping.
        let startEdgeX = spanStartX;  // moves left for start-anchored items
        let endEdgeX = spanEndX;      // moves right for end-anchored items
        let aboveY = barTop - gap;    // bottom edge of the next above-anchored item
        let belowY = barBottom + gap; // top edge of the next below-anchored item

        if (cons.icons && cons.icons.length) {
            const defaultSize = c.barIconSize;
            for (const icon of cons.icons) {
                if (!icon || !icon.source) continue;
                const img = this._getImage(icon.source);
                // Skip until the image has loaded; its onload triggers a re-render.
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
                if (pos === 'end') {
                    const x = endEdgeX + gap;
                    ctx.drawImage(img, x, barCenterY - h / 2, w, h);
                    endEdgeX = x + w;
                } else if (pos === 'above') {
                    ctx.drawImage(img, barCenterX - w / 2, aboveY - h, w, h);
                    aboveY -= h + gap;
                } else if (pos === 'below') {
                    ctx.drawImage(img, barCenterX - w / 2, belowY, w, h);
                    belowY += h + gap;
                } else { // 'start' (default)
                    const x = startEdgeX - gap - w;
                    ctx.drawImage(img, x, barCenterY - h / 2, w, h);
                    startEdgeX = x;
                }
            }
        }

        ctx.font = c.barLabelFont;
        ctx.fillStyle = c.colors.barLabel;

        if (cons.textAbove) {
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillText(cons.textAbove, barCenterX, aboveY);
        }
        if (cons.textBelow) {
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(cons.textBelow, barCenterX, belowY);
        }
        if (cons.textStart) {
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText(cons.textStart, startEdgeX - gap, barCenterY);
        }
        if (cons.textEnd) {
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(cons.textEnd, endEdgeX + gap, barCenterY);
        }
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
                if (this._hasData()) this.render();
            };
            // On error the image stays incomplete (naturalWidth === 0) and is
            // simply skipped when drawing.
            img.onerror = () => { };
            img.src = src;
        }
        return img;
    }

    // ---- Pointer interaction: click, Ctrl/Cmd-click, and marquee drag ----

    // Converts a viewport pointer event to canvas-local coordinates.
    _eventToCanvas(e) {
        const rect = this.canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    // True when the point lies within the scrollable content area (i.e. not on
    // either sticky axis).
    _isInContentArea(canvasX, canvasY) {
        return canvasX >= this.config.resourceAxisWidth && canvasY >= this.config.timeAxisHeight;
    }

    // Converts canvas-local coordinates into scroll-independent content
    // coordinates so an in-progress marquee tracks the data while scrolling.
    _canvasToContent(canvasX, canvasY) {
        return {
            x: canvasX - this.config.resourceAxisWidth + this.scrollX,
            y: canvasY - this.config.timeAxisHeight + this.scrollY
        };
    }

    handleMouseDown(e) {
        // Only react to the primary (left) button.
        if (e.button !== 0) return;

        const { x: canvasX, y: canvasY } = this._eventToCanvas(e);

        // Presses on the sticky axes clear the selection (unless modified).
        if (!this._isInContentArea(canvasX, canvasY)) {
            if (!this._isAdditiveEvent(e)) {
                this._clearSelectionInternal();
            }
            return;
        }

        const content = this._canvasToContent(canvasX, canvasY);
        // Prevent the press from starting a native text/image selection while
        // dragging the marquee.
        e.preventDefault();
        this.drag = {
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

    handleMouseMove(e) {
        if (!this.drag) return;

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

    handleMouseUp(e) {
        if (!this.drag) return;

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

    // Selects (or toggles) the single bar nearest the click point.
    _handleClickSelect(canvasX, canvasY, additive) {
        if (!this._isInContentArea(canvasX, canvasY)) return;

        const resourceIndex = this.getYToResource(canvasY);
        if (resourceIndex === -1) {
            if (!additive) this._clearSelectionInternal();
            this._notifySelection();
            return;
        }

        const resource = this.resources[resourceIndex];
        const clickTime = this.getXToTime(canvasX);

        // Scan this resource's bars. Hit-testing uses each bar's effective span
        // (the main bar plus any start/end edge bars), so clicking an edge bar
        // selects its owning consumption.
        const resourceConsumptions = this.consumptionsByResource.get(resource.id) || [];
        let clickedBar = null;
        let minDistance = Infinity;
        for (const cons of resourceConsumptions) {
            const effStart = this._effectiveStartTime(cons);
            const effEnd = this._effectiveEndTime(cons);
            if (clickTime >= effStart && clickTime <= effEnd) {
                const barCenterX = (this.getTimeToX(cons.startTime) + this.getTimeToX(cons.endTime)) / 2;
                const distance = Math.abs(canvasX - barCenterX);
                if (distance < minDistance) {
                    minDistance = distance;
                    clickedBar = cons;
                }
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
        for (let resourceIndex = 0; resourceIndex < this.resources.length; resourceIndex++) {
            // Row bounds in content space.
            const rowTop = resourceIndex * c.resourceHeight;
            const rowBottom = rowTop + c.resourceHeight;
            if (rowBottom < minY || rowTop > maxY) continue;

            const resource = this.resources[resourceIndex];
            const resourceConsumptions = this.consumptionsByResource.get(resource.id);
            if (!resourceConsumptions) continue;

            for (const cons of resourceConsumptions) {
                // Bar horizontal bounds in content space, including edge bars.
                const barStartX = this._timeToContentX(this._effectiveStartTime(cons));
                const barEndX = Math.max(barStartX + c.minBarWidth, this._timeToContentX(this._effectiveEndTime(cons)));
                if (barEndX < minX || barStartX > maxX) continue;
                next.set(cons.id, cons);
            }
        }

        this.selectedBars = next;
    }

    // Time -> content-space X (scroll-independent), mirroring getTimeToX.
    _timeToContentX(time) {
        const wrapperRect = this.wrapper.getBoundingClientRect();
        const visibleWidth = wrapperRect.width - this.config.resourceAxisWidth;
        if (visibleWidth <= 0) return 0;
        const pixelsPerMs = (visibleWidth / 24) / (60 * 60 * 1000);
        return (time - this.timeRange.start) * pixelsPerMs;
    }

    // Effective start/end times of a consumption, extended to cover any
    // start/end edge (delay) bars. Used so edge bars count as part of the bar
    // for hit-testing and selection.
    _effectiveStartTime(cons) {
        const edge = cons.startBar && cons.startBar.duration > 0 ? cons.startBar.duration : 0;
        return cons.startTime - edge;
    }

    _effectiveEndTime(cons) {
        const edge = cons.endBar && cons.endBar.duration > 0 ? cons.endBar.duration : 0;
        return cons.endTime + edge;
    }

    // Draws the marquee rectangle (converting content coords back to canvas).
    drawSelectionRect() {
        if (!this.drag || !this.drag.moved) return;

        const c = this.config;
        const x1 = this.drag.startX - this.scrollX + c.resourceAxisWidth;
        const y1 = this.drag.startY - this.scrollY + c.timeAxisHeight;
        const x2 = this.drag.currentX - this.scrollX + c.resourceAxisWidth;
        const y2 = this.drag.currentY - this.scrollY + c.timeAxisHeight;

        const left = Math.min(x1, x2);
        const top = Math.min(y1, y2);
        const width = Math.abs(x2 - x1);
        const height = Math.abs(y2 - y1);

        // Clip to the content area so the rectangle never overlaps the axes.
        const ctx = this.ctx;
        const wrapperRect = this.wrapper.getBoundingClientRect();
        ctx.save();
        ctx.beginPath();
        ctx.rect(
            c.resourceAxisWidth,
            c.timeAxisHeight,
            wrapperRect.width - c.resourceAxisWidth,
            wrapperRect.height - c.timeAxisHeight
        );
        ctx.clip();

        ctx.fillStyle = c.colors.selectionFill;
        ctx.fillRect(left, top, width, height);
        ctx.strokeStyle = c.colors.selectionBorder;
        ctx.lineWidth = 1;
        ctx.strokeRect(left + 0.5, top + 0.5, width, height);
        ctx.restore();
    }

    // Clears the selection without notifying .NET.
    _clearSelectionInternal() {
        if (this.selectedBars.size === 0) return;
        this.selectedBars.clear();
        this.render();
        this._notifySelection();
    }

    // Notifies .NET of the current selection state.
    _notifySelection() {
        if (!this.dotNetRef) return;

        const all = Array.from(this.selectedBars.values());
        this.dotNetRef.invokeMethodAsync('OnSelectionUpdated', all);
    }

    // ---- Public API invoked from .NET ----

    // Returns the fixed layout dimensions so the host can position overlays
    // (such as the top-start corner template) over the canvas.
    getLayout() {
        return {
            resourceAxisWidth: this.config.resourceAxisWidth,
            timeAxisHeight: this.config.timeAxisHeight,
            resourceHeight: this.config.resourceHeight
        };
    }

    // Scrolls horizontally so the given time is centered in the content area.
    // Returns true if the time is within range and navigation happened.
    scrollToTime(time) {
        if (!this._hasData()) return false;
        if (time < this.timeRange.start || time > this.timeRange.end) return false;

        const wrapperRect = this.wrapper.getBoundingClientRect();
        const visibleWidth = wrapperRect.width - this.config.resourceAxisWidth;
        if (visibleWidth <= 0) return false;

        const pixelsPerMs = (visibleWidth / 24) / (60 * 60 * 1000);
        const contentX = (time - this.timeRange.start) * pixelsPerMs;

        // Center the target, then clamp to the scrollable range.
        let targetScrollLeft = contentX - visibleWidth / 2;
        const maxScrollLeft = Math.max(0, this.wrapper.scrollWidth - this.wrapper.clientWidth);
        targetScrollLeft = Math.max(0, Math.min(targetScrollLeft, maxScrollLeft));

        this.wrapper.scrollTo({ left: targetScrollLeft, behavior: 'smooth' });
        return true;
    }

    // Navigates to the current time. Returns true if "now" is within the
    // timeline's data range (and navigation happened), false otherwise.
    goToNow() {
        return this.scrollToTime(Date.now());
    }

    // Rebuilds the resourceId -> sorted consumptions index used for
    // rendering and hit-testing.
    _indexConsumptions() {
        const index = new Map();
        for (const cons of this.consumptions) {
            let list = index.get(cons.resourceId);
            if (!list) {
                list = [];
                index.set(cons.resourceId, list);
            }
            list.push(cons);
        }
        // Each resource's list inherits global sort order, so it is already
        // sorted by startTime.
        this.consumptionsByResource = index;
    }

    setResources(resources) {
        this.resources = resources || [];
        if (this.timeRange.start && this.timeRange.end) {
            this.setupCanvas();
        }
    }

    setTimeRange(start, end) {
        this.timeRange = { start, end };
        if (this.resources.length > 0) {
            this.setupCanvas();
        }
    }

    setConsumptions(consumptions) {
        this.consumptions = (consumptions || []).slice().sort((a, b) => a.startTime - b.startTime);
        this._indexConsumptions();
        if (this.canvas.width > 0 && this.canvas.height > 0) {
            this.render();
        }
    }

    setData(resources, start, end, consumptions) {
        this.resources = resources || [];
        this.timeRange = { start, end };
        this.consumptions = (consumptions || []).slice().sort((a, b) => a.startTime - b.startTime);
        this._indexConsumptions();
        this.selectedBars.clear();
        this.drag = null;
        // A paint is expected as a result of this data change; whenRendered()
        // will wait for it rather than resolving on the next idle frame.
        this._renderPending = true;
        this.setupCanvas();
    }

    clearSelection() {
        this._clearSelectionInternal();
    }

    getSelectedBar() {
        const all = Array.from(this.selectedBars.values());
        return all.length > 0 ? all[all.length - 1] : null;
    }

    getSelectedBars() {
        return Array.from(this.selectedBars.values());
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
        window.removeEventListener('resize', this._onResize);
        this.wrapper.removeEventListener('scroll', this._onScroll);
        this.canvas.removeEventListener('mousedown', this._onMouseDown);
        window.removeEventListener('mousemove', this._onMouseMove);
        window.removeEventListener('mouseup', this._onMouseUp);
        this.canvas.removeEventListener('contextmenu', this._onContextMenu);
        const contentDiv = this.wrapper.querySelector('.timeline-content');
        if (contentDiv) contentDiv.remove();
        this.imageCache.clear();
        this._flushRenderedResolvers();
        this.dotNetRef = null;
    }
}
