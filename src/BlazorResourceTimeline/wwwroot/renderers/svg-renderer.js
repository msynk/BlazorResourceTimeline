// SVG renderer for the BlazorResourceTimeline engine: renders the scene built
// by the engine (see timeline-engine.js for the renderer contract and scene
// shape) into an <svg> element. The scene is already culled to the viewport, so
// the element count stays bounded by what is visible.
//
// Compared to canvas, SVG output is resolution-independent (crisp at any
// zoom/DPR without backing-store management), styleable and inspectable in
// devtools, and copy/print friendly. Canvas remains faster for very dense
// scenes.
//
// The group structure below is created once and kept; its children are pooled
// and reused across frames (see ./node-pool.js), so a steady-state frame
// creates no elements and writes only the attributes that actually changed.

import { NodePool, applyAttrs, setText } from './node-pool.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Unique clip-path id prefix per renderer instance so multiple timelines on
// one page never collide.
let instanceCounter = 0;

function el(name, attrs) {
    const node = document.createElementNS(SVG_NS, name);
    if (attrs) {
        for (const key of Object.keys(attrs)) node.setAttribute(key, attrs[key]);
    }
    return node;
}

// Maps the scene's canvas-style align/baseline to SVG text attributes.
const ANCHOR = { left: 'start', center: 'middle', right: 'end' };
const BASELINE = { top: 'hanging', middle: 'central', bottom: 'auto' };

export class SvgRenderer {
    constructor(wrapper, host) {
        this.wrapper = wrapper;
        this.host = host;

        this.surface = el('svg');
        this.surface.setAttribute('class', 'timeline-surface');
        wrapper.appendChild(this.surface);

        const id = ++instanceCounter;
        this._contentClipId = `brt-svg-content-clip-${id}`;
        this._axisClipId = `brt-svg-axis-clip-${id}`;

        // Persistent structure: <defs> with the two clip paths, then one group
        // per layer in paint order, each backed by a pool.
        this._contentClipRect = el('rect');
        this._axisClipRect = el('rect');
        const defs = el('defs');
        const contentClip = el('clipPath', { id: this._contentClipId });
        contentClip.appendChild(this._contentClipRect);
        const axisClip = el('clipPath', { id: this._axisClipId });
        axisClip.appendChild(this._axisClipRect);
        defs.appendChild(contentClip);
        defs.appendChild(axisClip);
        this.surface.appendChild(defs);

        const group = (attrs) => {
            const g = el('g', attrs);
            this.surface.appendChild(g);
            return g;
        };
        this._bgGroup = group();
        this._gridGroup = group();
        this._barsGroup = group();
        this._nowGroup = group();
        this._timeAxisGroup = group();
        this._resourceAxisGroup = group();
        this._resourceLabelGroup = group({ 'clip-path': `url(#${this._axisClipId})` });
        this._overlayGroup = group({ 'clip-path': `url(#${this._contentClipId})` });

        // One pool per homogeneous run of elements - see node-pool.js for why a
        // pool must not be fed a varying mix of tags. Splitting the bar group
        // this way also keeps data-bar-id confined to the barRects pool, so a
        // reused element can never surface a stale id.
        const clearBarId = (node) => {
            if (node.__barId !== undefined) {
                node.removeAttribute('data-bar-id');
                node.__barId = undefined;
            }
        };
        const pool = (parent, onHide) => new NodePool(parent, SVG_NS, onHide);
        this._pools = {
            bg: pool(this._bgGroup),
            gridH: pool(this._gridGroup),
            gridV: pool(this._gridGroup),
            barEdges: pool(this._barsGroup),
            barRects: pool(this._barsGroup, clearBarId),
            barOutlines: pool(this._barsGroup),
            barIcons: pool(this._barsGroup),
            barLabels: pool(this._barsGroup),
            now: pool(this._nowGroup),
            axisBg: pool(this._timeAxisGroup),
            axisLines: pool(this._timeAxisGroup),
            axisDayLabels: pool(this._timeAxisGroup),
            axisTicks: pool(this._timeAxisGroup),
            axisTickLabels: pool(this._timeAxisGroup),
            resourceAxis: pool(this._resourceAxisGroup),
            resChevrons: pool(this._resourceLabelGroup),
            resLabels: pool(this._resourceLabelGroup),
            overlayRects: pool(this._overlayGroup),
            overlayLabels: pool(this._overlayGroup)
        };
    }

    resize(cssW, cssH) {
        this.surface.style.width = cssW + 'px';
        this.surface.style.height = cssH + 'px';
        this.surface.setAttribute('viewBox', `0 0 ${cssW} ${cssH}`);
    }

    render(scene) {
        const v = scene.viewport;

        // Keep the clip regions in sync with the (possibly changed) layout.
        // Content clip: the scrollable area under/right of the sticky axes.
        applyAttrs(this._contentClipRect, {
            x: v.axisWidth, y: v.axisHeight,
            width: Math.max(0, v.width - v.axisWidth),
            height: Math.max(0, v.height - v.axisHeight)
        });
        // Axis clip: the resource column below the time axis, so long labels
        // don't bleed across the divider into the content area.
        applyAttrs(this._axisClipRect, {
            x: 0, y: v.axisHeight,
            width: Math.max(0, v.axisWidth - 1),
            height: Math.max(0, v.height - v.axisHeight)
        });

        for (const key in this._pools) this._pools[key].begin();

        this._buildBackground(scene);
        this._buildGrid(scene);
        this._buildBars(scene);
        this._buildNowLine(scene);
        this._buildTimeAxis(scene);
        this._buildResourceAxis(scene);
        this._buildOverlays(scene);

        for (const key in this._pools) this._pools[key].end();
    }

    // Every attribute this renderer ever sets on a rect is written here, so a
    // reused element never keeps a stroke or opacity from a previous frame.
    _rect(pool, x, y, width, height, fill, stroke, strokeWidth, dash, fillOpacity) {
        const node = pool.acquire('rect');
        applyAttrs(node, {
            x, y,
            width: Math.max(0, width),
            height: Math.max(0, height),
            fill: fill || 'none',
            'fill-opacity': fillOpacity === undefined ? '1' : String(fillOpacity),
            stroke: stroke || 'none',
            'stroke-width': strokeWidth === undefined ? '1' : String(strokeWidth),
            'stroke-dasharray': dash || 'none'
        });
        return node;
    }

    _line(pool, x1, y1, x2, y2, stroke, width) {
        const node = pool.acquire('line');
        applyAttrs(node, {
            x1, y1, x2, y2,
            stroke,
            'stroke-width': width === undefined ? 1 : width,
            'shape-rendering': 'crispEdges'
        });
        return node;
    }

    _text(pool, content, x, y, font, fill, align, baseline) {
        const node = pool.acquire('text');
        applyAttrs(node, {
            x, y, fill,
            'text-anchor': ANCHOR[align] || 'start',
            'dominant-baseline': BASELINE[baseline] || 'auto'
        });
        if (node.__font !== font) {
            node.style.font = font;
            node.__font = font;
        }
        setText(node, content);
        return node;
    }

    _buildBackground(scene) {
        const pool = this._pools.bg;
        const colors = scene.config.colors;
        const v = scene.viewport;
        const contentWidth = v.width - v.axisWidth;
        const contentHeight = v.height - v.axisHeight;

        this._rect(pool, v.axisWidth, v.axisHeight, contentWidth, contentHeight, colors.contentBg);
        this._rect(pool, 0, 0, v.axisWidth, v.axisHeight, colors.axisBg);
        this._rect(pool, 0, v.axisHeight, v.axisWidth, contentHeight, colors.axisBg);
        this._rect(pool, v.axisWidth, 0, contentWidth, v.axisHeight, colors.axisBg);
    }

    _buildGrid(scene) {
        const grid = scene.config.colors.grid;
        const v = scene.viewport;
        for (const y of scene.gridH) {
            this._line(this._pools.gridH, v.axisWidth, y, v.width, y, grid);
        }
        for (const x of scene.gridV) {
            this._line(this._pools.gridV, x, v.axisHeight, x, v.height, grid);
        }
    }

    _buildBars(scene) {
        const p = this._pools;
        const c = scene.config;

        for (const bar of scene.bars) {
            if (bar.edges) {
                for (const edge of bar.edges) {
                    this._rect(p.barEdges, edge.x, edge.y, edge.width, edge.height, edge.color);
                }
            }

            const barEl = this._rect(p.barRects, bar.x, bar.y, bar.width, bar.height, bar.color);
            if (barEl.__barId !== bar.id) {
                barEl.setAttribute('data-bar-id', bar.id);
                barEl.__barId = bar.id;
            }

            if (bar.outline) {
                this._rect(p.barOutlines, bar.outline.x, bar.outline.y, bar.outline.width, bar.outline.height,
                    null, c.colors.barSelectedBorder, 2);
            }

            if (bar.focusRing) {
                this._rect(p.barOutlines, bar.focusRing.x, bar.focusRing.y, bar.focusRing.width, bar.focusRing.height,
                    null, c.colors.focus, 2, '3 2');
            }

            if (bar.icons) {
                for (const icon of bar.icons) {
                    // Only emit an <image> once the engine's cache reports the
                    // source as loaded, so a not-yet-decoded icon doesn't flash
                    // in as a broken box. The cache load triggers a re-render.
                    const cached = this.host.getImage(icon.source);
                    if (!cached || !cached.complete || cached.naturalWidth === 0) continue;
                    const img = p.barIcons.acquire('image');
                    applyAttrs(img, {
                        href: icon.source,
                        x: icon.x, y: icon.y,
                        width: icon.width, height: icon.height,
                        // The scene already fitted the box to the image's
                        // aspect ratio.
                        preserveAspectRatio: 'none'
                    });
                }
            }

            if (bar.labels) {
                for (const label of bar.labels) {
                    this._text(p.barLabels, label.text, label.x, label.y,
                        c.barLabelFont, c.colors.barLabel, label.align, label.baseline);
                }
            }
        }
    }

    _buildNowLine(scene) {
        if (scene.nowX == null) return;
        const pool = this._pools.now;
        const colors = scene.config.colors;
        const v = scene.viewport;
        const x = scene.nowX;

        const line = pool.acquire('line');
        applyAttrs(line, {
            x1: x, y1: v.axisHeight, x2: x, y2: v.height,
            stroke: colors.now, 'stroke-width': 2
        });
        // Small triangular marker at the top of the line.
        const marker = pool.acquire('path');
        applyAttrs(marker, {
            d: `M ${x - 4} ${v.axisHeight} L ${x + 4} ${v.axisHeight} L ${x} ${v.axisHeight + 5} Z`,
            fill: colors.now
        });
    }

    _buildTimeAxis(scene) {
        const p = this._pools;
        const colors = scene.config.colors;
        const v = scene.viewport;
        const startX = v.axisWidth;

        this._rect(p.axisBg, startX, 0, v.width - startX, v.axisHeight, colors.axisBg);
        // Bottom border of the whole axis, the date/hour row divider, then the
        // day separators - all lines, so they share one pool.
        this._line(p.axisLines, startX, v.axisHeight, v.width, v.axisHeight, colors.axisBorder);
        this._line(p.axisLines, startX, v.dateRowHeight, v.width, v.dateRowHeight, colors.axisBorder);
        for (const day of scene.days) {
            if (day.sepX != null) {
                this._line(p.axisLines, day.sepX, 0, day.sepX, v.dateRowHeight, colors.axisBorder);
            }
        }
        for (const day of scene.days) {
            if (day.label != null) {
                this._text(p.axisDayLabels, day.label, day.labelX, day.labelY,
                    scene.config.dateLabelFont, colors.dateLabel, 'left', 'middle');
            }
        }

        for (const tick of scene.hourTicks) {
            this._line(p.axisTicks, tick.x, v.axisHeight - 8, tick.x, v.axisHeight, colors.tick);
        }
        for (const tick of scene.hourTicks) {
            this._text(p.axisTickLabels, tick.label, tick.x, tick.labelY,
                scene.config.hourLabelFont, colors.label, 'center', 'middle');
        }
    }

    _buildResourceAxis(scene) {
        const c = scene.config;
        const colors = c.colors;
        const v = scene.viewport;
        const startY = v.axisHeight;

        const pool = this._pools.resourceAxis;
        this._rect(pool, 0, startY, v.axisWidth, v.height - startY, colors.axisBg);
        this._line(pool, v.axisWidth, startY, v.axisWidth, v.height, colors.axisBorder);

        // When the HTML resource-column template overlay is active it renders
        // the labels/chevrons; only the axis background/border is painted.
        if (!scene.resourceRows) return;

        const p = this._pools;
        for (const row of scene.resourceRows) {
            if (row.hasChildren) {
                this._text(p.resChevrons, row.collapsed ? '▶' : '▼', row.leftPad, row.midY,
                    c.resourceChevronFont, colors.label, 'left', 'middle');
                this._text(p.resLabels, row.name, row.leftPad + c.resourceChevronGap, row.midY,
                    c.resourceGroupFont, colors.dateLabel, 'left', 'middle');
            } else {
                this._text(p.resLabels, row.name, row.leftPad, row.midY,
                    c.resourceLabelFont, colors.label, 'left', 'middle');
            }
        }
    }

    _buildOverlays(scene) {
        const rects = this._pools.overlayRects;
        const c = scene.config;
        const colors = c.colors;

        const m = scene.marquee;
        if (m) {
            this._rect(rects, m.x, m.y, m.width, m.height, colors.selectionFill);
            this._rect(rects, m.x + 0.5, m.y + 0.5, m.width, m.height,
                null, colors.selectionBorder, 1);
        }

        const g = scene.ghost;
        if (g) {
            this._rect(rects, g.x, g.y, g.width, g.height, g.color, null, undefined, null, 0.7);
            this._rect(rects, g.x + 0.5, g.y - 0.5, g.width, g.height + 1,
                null, c.colors.barSelectedBorder, 1, '4 2');
            // Time readout above the ghost for precise feedback while dragging.
            if (g.label) {
                this._text(this._pools.overlayLabels, g.label, g.x, g.y - 2,
                    c.barLabelFont, colors.dateLabel, 'left', 'bottom');
            }
        }
    }

    dispose() {
        for (const key in this._pools) this._pools[key].clear();
        this.surface.remove();
    }
}
