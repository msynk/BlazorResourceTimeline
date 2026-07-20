// Canvas renderer for the BlazorResourceTimeline engine: immediate-mode paint
// of the scene built by the engine each frame (see timeline-engine.js for the
// renderer contract and the scene shape). This is the default renderer and the
// fastest one for large, dense datasets.
//
// The renderer owns everything canvas-specific: the <canvas> surface element,
// the HiDPI backing store (sized in device pixels for crisp output) and the
// device-pixel ResizeObserver that tracks devicePixelRatio changes.

export class CanvasRenderer {
    constructor(wrapper, host) {
        this.wrapper = wrapper;
        this.host = host;

        this.surface = document.createElement('canvas');
        this.surface.className = 'timeline-surface';
        wrapper.appendChild(this.surface);
        this.ctx = this.surface.getContext('2d', { alpha: false });

        // Canvas backing-store size in device pixels (for crisp HiDPI output)
        // and the resulting CSS-pixel -> device-pixel scale factors.
        this._cssW = 0;
        this._cssH = 0;
        this._deviceW = 0;
        this._deviceH = 0;
        this._scaleX = 1;
        this._scaleY = 1;

        // Observe the canvas backing-store size in device pixels (via
        // device-pixel-content-box where supported) so devicePixelRatio
        // changes (browser zoom, moving between monitors) are picked up.
        this._resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const dpc = entry.devicePixelContentBoxSize && entry.devicePixelContentBoxSize[0];
                if (dpc) {
                    this._deviceW = dpc.inlineSize;
                    this._deviceH = dpc.blockSize;
                }
            }
            // Re-apply the backing store at the new density and repaint.
            // Changing canvas.width/height clears the bitmap; paint synchronously
            // when that happens so a blank frame is never presented.
            if (this._cssW > 0 && this._cssH > 0) {
                if (this._applyBackingStore()) {
                    if (typeof this.host.paintNow === 'function') this.host.paintNow();
                    else this.host.requestRender();
                } else {
                    this.host.requestRender();
                }
            }
        });
        try {
            this._resizeObserver.observe(this.surface, { box: 'device-pixel-content-box' });
            this._observesDevicePixels = true;
        } catch {
            // Safari does not support device-pixel-content-box; fall back to
            // CSS pixels multiplied by devicePixelRatio on each resize.
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
            this._observesDevicePixels = false;
        }
    }

    // Returns true when the device-pixel backing store was resized (and thus
    // cleared). Callers that need a continuous picture should paint immediately.
    resize(cssW, cssH) {
        this._cssW = cssW;
        this._cssH = cssH;
        this.surface.style.width = cssW + 'px';
        this.surface.style.height = cssH + 'px';
        return this._applyBackingStore();
    }

    // Sizes the backing store in device pixels. The scale is capped so very
    // high DPR displays (some phones report 3-4) don't multiply the fill cost.
    // Returns true when width/height were written (bitmap cleared by the browser).
    _applyBackingStore() {
        const cssW = this._cssW;
        const cssH = this._cssH;
        if (cssW === 0 || cssH === 0) return false;

        const maxScale = 2;
        let deviceW, deviceH;
        if (this._observesDevicePixels &&
            this._deviceW > 0 && this._deviceH > 0 && this._deviceW <= cssW * maxScale) {
            // Exact device-pixel size from the observer: pixel-perfect.
            deviceW = this._deviceW;
            deviceH = this._deviceH;
        } else {
            const scale = Math.min(maxScale, window.devicePixelRatio || 1);
            deviceW = Math.round(cssW * scale);
            deviceH = Math.round(cssH * scale);
        }

        let cleared = false;
        if (this.surface.width !== deviceW || this.surface.height !== deviceH) {
            // Assigning width/height resets the bitmap to transparent black.
            this.surface.width = deviceW;
            this.surface.height = deviceH;
            cleared = true;
        }
        this._scaleX = deviceW / cssW;
        this._scaleY = deviceH / cssH;
        return cleared;
    }

    render(scene) {
        if (this.surface.width === 0 || this.surface.height === 0) return;
        const ctx = this.ctx;

        // Draw in CSS pixels: the transform maps CSS-pixel drawing onto the
        // (possibly higher-resolution) device-pixel backing store.
        //
        // No clearRect: the context is opaque (alpha: false) and _drawBackground
        // immediately fills the entire viewport, so clearing first was a wasted
        // full-surface fill - on a 4K display at 2x that is ~33M pixels a frame.
        ctx.setTransform(this._scaleX, 0, 0, this._scaleY, 0, 0);

        // z-order: background -> grid -> bars -> now line -> sticky axes ->
        // marquee -> edit ghost (matches the scene contract).
        this._drawBackground(scene);
        this._drawGrid(scene);
        this._drawBars(scene);
        this._drawNowLine(scene);
        this._drawTimeAxis(scene);
        this._drawResourceAxis(scene);
        this._drawMarquee(scene);
        this._drawGhost(scene);
    }

    _drawBackground(scene) {
        const { colors } = scene.config;
        const v = scene.viewport;
        const contentWidth = v.width - v.axisWidth;
        const contentHeight = v.height - v.axisHeight;

        this.ctx.fillStyle = colors.contentBg;
        this.ctx.fillRect(v.axisWidth, v.axisHeight, contentWidth, contentHeight);

        this.ctx.fillStyle = colors.axisBg;
        this.ctx.fillRect(0, 0, v.axisWidth, v.axisHeight);
        this.ctx.fillRect(0, v.axisHeight, v.axisWidth, contentHeight);
        this.ctx.fillRect(v.axisWidth, 0, contentWidth, v.axisHeight);
    }

    // All grid lines share one style, so they go into a single path with one
    // stroke instead of a begin/stroke pair each - dozens of rasterizer setups
    // per frame otherwise. The half-pixel offset puts a 1px line inside a pixel
    // row rather than straddling two, which is what made the grid look blurry.
    _drawGrid(scene) {
        const ctx = this.ctx;
        const v = scene.viewport;
        ctx.strokeStyle = scene.config.colors.grid;
        ctx.lineWidth = 1;

        ctx.beginPath();
        for (const y of scene.gridH) {
            const py = Math.round(y) + 0.5;
            ctx.moveTo(v.axisWidth, py);
            ctx.lineTo(v.width, py);
        }
        for (const x of scene.gridV) {
            const px = Math.round(x) + 0.5;
            ctx.moveTo(px, v.axisHeight);
            ctx.lineTo(px, v.height);
        }
        ctx.stroke();
    }

    _drawBars(scene) {
        const ctx = this.ctx;
        const c = scene.config;
        // Assigning ctx.font re-parses the font string, so it is set once for
        // the whole pass rather than per labelled bar. fillStyle cannot be
        // hoisted the same way - each bar's fill overwrites it.
        let fontSet = false;

        for (const bar of scene.bars) {
            if (bar.edges) {
                for (const edge of bar.edges) {
                    ctx.fillStyle = edge.color;
                    ctx.fillRect(edge.x, edge.y, edge.width, edge.height);
                }
            }

            ctx.fillStyle = bar.color;
            ctx.fillRect(bar.x, bar.y, bar.width, bar.height);

            if (bar.outline) {
                ctx.strokeStyle = c.colors.barSelectedBorder;
                ctx.lineWidth = 2;
                ctx.strokeRect(bar.outline.x, bar.outline.y, bar.outline.width, bar.outline.height);
            }

            if (bar.focusRing) {
                ctx.save();
                ctx.strokeStyle = c.colors.focus;
                ctx.lineWidth = 2;
                ctx.setLineDash([3, 2]);
                ctx.strokeRect(bar.focusRing.x, bar.focusRing.y, bar.focusRing.width, bar.focusRing.height);
                ctx.restore();
            }

            if (bar.icons) {
                for (const icon of bar.icons) {
                    const img = this.host.getImage(icon.source);
                    // Layout only emits icons whose image has loaded, but a
                    // cache eviction/reload keeps this guard cheap insurance.
                    if (!img || !img.complete || img.naturalWidth === 0) continue;
                    ctx.drawImage(img, icon.x, icon.y, icon.width, icon.height);
                }
            }

            if (bar.labels) {
                if (!fontSet) {
                    ctx.font = c.barLabelFont;
                    fontSet = true;
                }
                ctx.fillStyle = c.colors.barLabel;
                for (const label of bar.labels) {
                    ctx.textAlign = label.align;
                    ctx.textBaseline = label.baseline;
                    ctx.fillText(label.text, label.x, label.y);
                }
            }
        }
    }

    _drawNowLine(scene) {
        if (scene.nowX == null) return;
        const ctx = this.ctx;
        const v = scene.viewport;
        const x = scene.nowX;

        ctx.strokeStyle = scene.config.colors.now;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, v.axisHeight);
        ctx.lineTo(x, v.height);
        ctx.stroke();

        // Small triangular marker at the top of the line.
        ctx.fillStyle = scene.config.colors.now;
        ctx.beginPath();
        ctx.moveTo(x - 4, v.axisHeight);
        ctx.lineTo(x + 4, v.axisHeight);
        ctx.lineTo(x, v.axisHeight + 5);
        ctx.closePath();
        ctx.fill();
    }

    _drawTimeAxis(scene) {
        const ctx = this.ctx;
        const colors = scene.config.colors;
        const v = scene.viewport;
        const startX = v.axisWidth;
        const visibleEndX = v.width;
        const axisHeight = v.axisHeight;
        const dateRowHeight = v.dateRowHeight;

        ctx.fillStyle = colors.axisBg;
        ctx.fillRect(startX, 0, visibleEndX - startX, axisHeight);

        // Bottom border of the whole axis.
        ctx.strokeStyle = colors.axisBorder;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(startX, axisHeight);
        ctx.lineTo(visibleEndX, axisHeight);
        ctx.stroke();

        // Divider between the date row and the hour row.
        ctx.beginPath();
        ctx.moveTo(startX, dateRowHeight);
        ctx.lineTo(visibleEndX, dateRowHeight);
        ctx.stroke();

        // Date row: separators batched into one stroke, then the pinned labels.
        ctx.strokeStyle = colors.axisBorder;
        ctx.beginPath();
        for (const day of scene.days) {
            if (day.sepX == null) continue;
            const px = Math.round(day.sepX) + 0.5;
            ctx.moveTo(px, 0);
            ctx.lineTo(px, dateRowHeight);
        }
        ctx.stroke();

        ctx.font = scene.config.dateLabelFont;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillStyle = colors.dateLabel;
        for (const day of scene.days) {
            if (day.label != null) {
                ctx.fillText(day.label, day.labelX, day.labelY);
            }
        }

        // Hour row: ticks batched into one stroke, then the hour-of-day labels.
        ctx.strokeStyle = colors.tick;
        ctx.beginPath();
        for (const tick of scene.hourTicks) {
            const px = Math.round(tick.x) + 0.5;
            ctx.moveTo(px, axisHeight - 8);
            ctx.lineTo(px, axisHeight);
        }
        ctx.stroke();

        ctx.textAlign = 'center';
        ctx.font = scene.config.hourLabelFont;
        ctx.fillStyle = colors.label;
        for (const tick of scene.hourTicks) {
            ctx.fillText(tick.label, tick.x, tick.labelY);
        }
    }

    _drawResourceAxis(scene) {
        const ctx = this.ctx;
        const colors = scene.config.colors;
        const v = scene.viewport;
        const axisWidth = v.axisWidth;
        const startY = v.axisHeight;
        const visibleEndY = v.height;

        ctx.fillStyle = colors.axisBg;
        ctx.fillRect(0, startY, axisWidth, visibleEndY - startY);

        ctx.strokeStyle = colors.axisBorder;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(axisWidth, startY);
        ctx.lineTo(axisWidth, visibleEndY);
        ctx.stroke();

        // When an HTML resource-column template is active, the overlay draws
        // the labels/chevrons; only the axis background/border is painted.
        if (!scene.resourceRows) return;

        ctx.textBaseline = 'middle';

        // Clip labels to the axis so long (left-aligned, indented) names don't
        // bleed across the divider into the content area.
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, startY, axisWidth - 1, visibleEndY - startY);
        ctx.clip();

        const c = scene.config;
        ctx.textAlign = 'left';
        for (const row of scene.resourceRows) {
            if (row.hasChildren) {
                // Chevron: ▸ collapsed, ▾ expanded. Drawn left-aligned at the
                // row's indent; clicking this band toggles the group.
                ctx.fillStyle = colors.label;
                ctx.font = c.resourceChevronFont;
                ctx.fillText(row.collapsed ? '▶' : '▼', row.leftPad, row.midY);

                ctx.fillStyle = colors.dateLabel;
                ctx.font = c.resourceGroupFont;
                ctx.fillText(row.name, row.leftPad + c.resourceChevronGap, row.midY);
            } else {
                ctx.fillStyle = colors.label;
                ctx.font = c.resourceLabelFont;
                ctx.fillText(row.name, row.leftPad, row.midY);
            }
        }

        ctx.restore();
    }

    // Clips to the content area so the rectangle never overlaps the axes.
    _clipContent(scene) {
        const v = scene.viewport;
        this.ctx.beginPath();
        this.ctx.rect(v.axisWidth, v.axisHeight, v.width - v.axisWidth, v.height - v.axisHeight);
        this.ctx.clip();
    }

    _drawMarquee(scene) {
        const m = scene.marquee;
        if (!m) return;
        const ctx = this.ctx;
        const colors = scene.config.colors;

        ctx.save();
        this._clipContent(scene);
        ctx.fillStyle = colors.selectionFill;
        ctx.fillRect(m.x, m.y, m.width, m.height);
        ctx.strokeStyle = colors.selectionBorder;
        ctx.lineWidth = 1;
        ctx.strokeRect(m.x + 0.5, m.y + 0.5, m.width, m.height);
        ctx.restore();
    }

    _drawGhost(scene) {
        const g = scene.ghost;
        if (!g) return;
        const ctx = this.ctx;
        const c = scene.config;

        ctx.save();
        this._clipContent(scene);

        ctx.globalAlpha = 0.7;
        ctx.fillStyle = g.color;
        ctx.fillRect(g.x, g.y, g.width, g.height);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = c.colors.barSelectedBorder;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 2]);
        ctx.strokeRect(g.x + 0.5, g.y - 0.5, g.width, g.height + 1);
        ctx.setLineDash([]);

        // Time readout above the ghost for precise feedback while dragging.
        if (g.label) {
            ctx.font = c.barLabelFont;
            ctx.fillStyle = c.colors.dateLabel;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'bottom';
            ctx.fillText(g.label, g.x, g.y - 2);
        }
        ctx.restore();
    }

    dispose() {
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        this.surface.remove();
    }
}
