// Canvas-based renderer for the ResourceTimeline Blazor component.
// Exposes a small factory used by the .razor component through JS interop.

export function createTimeline(canvasId, dotNetRef) {
    return new ResourceTimeline(canvasId, dotNetRef);
}

class ResourceTimeline {
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
                now: '#e03131'
            }
        };

        // Data
        this.resources = [];
        this.timeRange = { start: null, end: null };
        this.consumptions = [];
        // Persistent index: resourceId -> consumptions[] (sorted by startTime).
        // Built once when data is set, reused for rendering and hit-testing.
        this.consumptionsByResource = new Map();

        // State
        this.selectedBar = null;
        this.scrollX = 0;
        this.scrollY = 0;

        // Performance helpers
        this.visibleTimeRange = null;
        this.animationFrame = null;
        this._scrollRaf = null;

        // Bound handlers so we can remove them on dispose
        this._onResize = () => this.resizeCanvas();
        this._onScroll = () => this._handleScroll();
        this._onClick = (e) => this.handleClick(e);
        this._onContextMenu = (e) => e.preventDefault();

        this._setupEventListeners();
    }

    _setupEventListeners() {
        window.addEventListener('resize', this._onResize);
        this.wrapper.addEventListener('scroll', this._onScroll, { passive: true });
        this.canvas.addEventListener('click', this._onClick);
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
                    return;
                }

                // z-order: background -> grid -> bars -> now line -> sticky axes
                this.drawBackground();
                this.drawGridLines();
                this.drawConsumptionBars();
                this.drawNowLine();
                this.drawTimeAxis();
                this.drawResourceAxis();
            } catch (error) {
                console.error('ResourceTimeline render error:', error);
            } finally {
                this.animationFrame = null;
            }
        });
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
            const barTop = barCenterY - c.barHeight / 2;
            const resourceConsumptions = this.consumptionsByResource.get(resource.id);
            if (!resourceConsumptions) continue;

            for (const cons of resourceConsumptions) {
                // Time-range culling (list is sorted by startTime).
                if (cons.endTime < visStart) continue;
                if (cons.startTime > visEnd) break;

                const barX = this.getTimeToX(cons.startTime);
                const barEndX = this.getTimeToX(cons.endTime);
                if (barEndX < startX || barX > visibleEndX) continue;

                const barWidth = Math.max(c.minBarWidth, barEndX - barX);
                const isSelected = this.selectedBar && this.selectedBar.id === cons.id;
                if (isSelected) {
                    this.ctx.fillStyle = cons.color || c.colors.barSelected;
                    this.ctx.fillRect(barX, barTop, barWidth, c.barHeight);
                    this.ctx.strokeStyle = c.colors.barSelectedBorder;
                    this.ctx.lineWidth = 2;
                    this.ctx.strokeRect(barX - 1, barTop - 1, barWidth + 2, c.barHeight + 2);
                } else {
                    this.ctx.fillStyle = cons.color || c.colors.bar;
                    this.ctx.fillRect(barX, barTop, barWidth, c.barHeight);
                }

                // Per-bar labels (only when present, to keep the common path cheap).
                if (cons.textAbove || cons.textBelow || cons.textStart || cons.textEnd) {
                    this._drawBarLabels(cons, barX, barEndX, barTop, barCenterY, c);
                }
            }
        }
    }

    // Renders the optional labels around a single bar. Positions:
    //   above  -> centered over the bar, baseline just above it
    //   below  -> centered under the bar, baseline just below it
    //   start  -> right-aligned, ending just before the bar's left edge
    //   end    -> left-aligned, starting just after the bar's right edge
    _drawBarLabels(cons, barX, barEndX, barTop, barCenterY, c) {
        const ctx = this.ctx;
        const gap = c.barLabelGap;
        ctx.font = c.barLabelFont;
        ctx.fillStyle = c.colors.barLabel;

        const barBottom = barTop + c.barHeight;
        const barCenterX = (barX + barEndX) / 2;

        if (cons.textAbove) {
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillText(cons.textAbove, barCenterX, barTop - gap);
        }
        if (cons.textBelow) {
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(cons.textBelow, barCenterX, barBottom + gap);
        }
        if (cons.textStart) {
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText(cons.textStart, barX - gap, barCenterY);
        }
        if (cons.textEnd) {
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(cons.textEnd, barEndX + gap, barCenterY);
        }
    }

    handleClick(e) {
        const rect = this.canvas.getBoundingClientRect();
        const canvasX = e.clientX - rect.left;
        const canvasY = e.clientY - rect.top;

        // Clicks on the sticky axes clear the selection.
        if (canvasX < this.config.resourceAxisWidth || canvasY < this.config.timeAxisHeight) {
            this._setSelection(null);
            return;
        }

        const resourceIndex = this.getYToResource(canvasY);
        if (resourceIndex === -1) return;

        const resource = this.resources[resourceIndex];
        const clickTime = this.getXToTime(canvasX);

        // Scan only this resource's bars (sorted by startTime) instead of all data.
        const resourceConsumptions = this.consumptionsByResource.get(resource.id) || [];
        let clickedBar = null;
        let minDistance = Infinity;
        for (const cons of resourceConsumptions) {
            if (cons.startTime > clickTime) break; // sorted: no later bar can contain the click
            if (clickTime <= cons.endTime) {
                const barCenterX = (this.getTimeToX(cons.startTime) + this.getTimeToX(cons.endTime)) / 2;
                const distance = Math.abs(canvasX - barCenterX);
                if (distance < minDistance) {
                    minDistance = distance;
                    clickedBar = cons;
                }
            }
        }

        this._setSelection(clickedBar);
    }

    _setSelection(bar) {
        this.selectedBar = bar;
        this.render();
        if (this.dotNetRef) {
            this.dotNetRef.invokeMethodAsync('OnBarSelected', bar);
        }
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
        this.selectedBar = null;
        this.setupCanvas();
    }

    clearSelection() {
        this._setSelection(null);
    }

    getSelectedBar() {
        return this.selectedBar;
    }

    dispose() {
        if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
        if (this._scrollRaf) cancelAnimationFrame(this._scrollRaf);
        window.removeEventListener('resize', this._onResize);
        this.wrapper.removeEventListener('scroll', this._onScroll);
        this.canvas.removeEventListener('click', this._onClick);
        this.canvas.removeEventListener('contextmenu', this._onContextMenu);
        const contentDiv = this.wrapper.querySelector('.timeline-content');
        if (contentDiv) contentDiv.remove();
        this.dotNetRef = null;
    }
}
