// HTML renderer for the BlazorResourceTimeline engine: renders the scene built
// by the engine (see timeline-engine.js for the renderer contract and scene
// shape) as absolutely-positioned DOM elements. The scene is already culled to
// the viewport, so the element count stays bounded by what is visible.
//
// Compared to canvas, HTML output is styleable with plain CSS (each bar is a
// real element carrying its allocation id in data-bar-id), inspectable in
// devtools and naturally crisp at any DPR. Canvas remains faster for very dense
// scenes.
//
// The layer containers below are created once and kept; their children are
// pooled and reused across frames (see ./node-pool.js), so a steady-state frame
// creates no elements and writes only the properties that actually changed.
//
// All children are pointer-events: none (inherited from the frame root), so
// pointer interaction flows to the surface element exactly as with the other
// renderers and the engine's geometric hit-testing stays authoritative.

import { NodePool, applyStyle, setText } from './node-pool.js';

function div(style) {
    const node = document.createElement('div');
    Object.assign(node.style, style);
    return node;
}

function px(value) {
    return value + 'px';
}

// Maps the scene's canvas-style align/baseline onto CSS transforms so the
// (x, y) anchor matches canvas text positioning.
const ALIGN_TX = { left: '0', center: '-50%', right: '-100%' };
const BASELINE_TY = { top: '0', middle: '-50%', bottom: '-100%' };

export class HtmlRenderer {
    constructor(wrapper, host) {
        this.wrapper = wrapper;
        this.host = host;

        this.surface = div({ overflow: 'hidden' });
        this.surface.className = 'timeline-surface';
        wrapper.appendChild(this.surface);

        // Persistent frame root. Children never receive pointer events; the
        // surface is the interaction target.
        this._frame = div({ position: 'absolute', inset: '0', pointerEvents: 'none' });
        this.surface.appendChild(this._frame);

        // Layers, in paint order. Each owns a pool of reusable children.
        const layer = () => {
            const el = div({ position: 'absolute', inset: '0' });
            this._frame.appendChild(el);
            return el;
        };
        this._bgLayer = layer();
        this._gridLayer = layer();
        this._barsLayer = layer();
        this._nowLayer = layer();

        // The two axes clip their own contents; an inner element shifts the
        // viewport-space coordinates back into the clip box.
        this._timeAxis = div({ position: 'absolute', overflow: 'hidden', boxSizing: 'border-box' });
        this._timeAxisInner = div({ position: 'absolute', top: '0' });
        this._timeAxis.appendChild(this._timeAxisInner);
        this._frame.appendChild(this._timeAxis);

        this._resourceAxis = div({ position: 'absolute', overflow: 'hidden', boxSizing: 'border-box' });
        this._resourceAxisInner = div({ position: 'absolute', left: '0' });
        this._resourceAxis.appendChild(this._resourceAxisInner);
        this._frame.appendChild(this._resourceAxis);

        // Marquee and edit ghost, clipped to the content area.
        this._overlayClip = div({ position: 'absolute', overflow: 'hidden' });
        this._overlayInner = div({ position: 'absolute' });
        this._overlayClip.appendChild(this._overlayInner);
        this._frame.appendChild(this._overlayClip);

        // One pool per homogeneous run. Splitting the bar layer this way also
        // fixes element identity: only the barRects pool ever carries a
        // data-bar-id, so a reused element can never surface a stale one.
        // Elements are grouped by kind within a layer, which puts icons and
        // labels above every bar rect - the intended stacking anyway.
        const clearBarId = (node) => {
            if (node.__barId !== undefined) {
                node.removeAttribute('data-bar-id');
                node.__barId = undefined;
            }
        };
        this._pools = {
            bg: new NodePool(this._bgLayer),
            gridH: new NodePool(this._gridLayer),
            gridV: new NodePool(this._gridLayer),
            barEdges: new NodePool(this._barsLayer),
            barRects: new NodePool(this._barsLayer, null, clearBarId),
            barOutlines: new NodePool(this._barsLayer),
            barIcons: new NodePool(this._barsLayer),
            barLabels: new NodePool(this._barsLayer),
            now: new NodePool(this._nowLayer),
            axisLines: new NodePool(this._timeAxisInner),
            axisDayLabels: new NodePool(this._timeAxisInner),
            axisTicks: new NodePool(this._timeAxisInner),
            axisTickLabels: new NodePool(this._timeAxisInner),
            resChevrons: new NodePool(this._resourceAxisInner),
            resLabels: new NodePool(this._resourceAxisInner),
            overlayRects: new NodePool(this._overlayInner),
            overlayLabels: new NodePool(this._overlayInner)
        };
    }

    resize(cssW, cssH) {
        this.surface.style.width = px(cssW);
        this.surface.style.height = px(cssH);
    }

    render(scene) {
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

    // A positioned rectangle from the given pool. Every style key this renderer
    // ever sets on a rect is written here, so a reused element never inherits a
    // border or opacity from whatever it was last frame.
    _rect(pool, x, y, width, height, background, border, opacity) {
        const node = pool.acquire('div');
        applyStyle(node, {
            position: 'absolute',
            left: px(x),
            top: px(y),
            width: px(Math.max(0, width)),
            height: px(Math.max(0, height)),
            background: background || '',
            border: border || '',
            boxSizing: border ? 'border-box' : '',
            opacity: opacity === undefined ? '' : String(opacity)
        });
        return node;
    }

    _text(pool, content, x, y, font, color, align, baseline) {
        const node = pool.acquire('div');
        applyStyle(node, {
            position: 'absolute',
            left: px(x),
            top: px(y),
            transform: `translate(${ALIGN_TX[align] || '0'}, ${BASELINE_TY[baseline] || '0'})`,
            font: font,
            color: color,
            whiteSpace: 'nowrap',
            lineHeight: '1'
        });
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
            this._rect(this._pools.gridH, v.axisWidth, y, v.width - v.axisWidth, 1, grid);
        }
        for (const x of scene.gridV) {
            this._rect(this._pools.gridV, x, v.axisHeight, 1, v.height - v.axisHeight, grid);
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
                barEl.dataset.barId = bar.id;
                barEl.__barId = bar.id;
            }

            // A 2px stroke centred on the rect covers one extra pixel on each
            // side; a border-box div grown by 1px per side matches that.
            if (bar.outline) {
                this._rect(p.barOutlines, bar.outline.x - 1, bar.outline.y - 1,
                    bar.outline.width + 2, bar.outline.height + 2,
                    null, `2px solid ${c.colors.barSelectedBorder}`);
            }

            if (bar.focusRing) {
                this._rect(p.barOutlines, bar.focusRing.x - 1, bar.focusRing.y - 1,
                    bar.focusRing.width + 2, bar.focusRing.height + 2,
                    null, `2px dashed ${c.colors.focus}`);
            }

            if (bar.icons) {
                for (const icon of bar.icons) {
                    // Go through the engine's image cache rather than assigning
                    // a fresh src per frame: one canonical load per source, and
                    // the src write is skipped entirely when unchanged. Matches
                    // the canvas renderer, which draws from the same cache.
                    const cached = this.host.getImage(icon.source);
                    if (!cached || !cached.complete || cached.naturalWidth === 0) continue;
                    const img = p.barIcons.acquire('img');
                    if (img.__src !== icon.source) {
                        img.src = icon.source;
                        img.alt = '';
                        img.__src = icon.source;
                    }
                    applyStyle(img, {
                        position: 'absolute',
                        left: px(icon.x),
                        top: px(icon.y),
                        width: px(icon.width),
                        height: px(icon.height)
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

        this._rect(pool, x - 1, v.axisHeight, 2, v.height - v.axisHeight, colors.now);
        // Small triangular marker at the top of the line (CSS border triangle).
        const marker = pool.acquire('div');
        applyStyle(marker, {
            position: 'absolute',
            left: px(x - 4),
            top: px(v.axisHeight),
            width: '0',
            height: '0',
            borderLeft: '4px solid transparent',
            borderRight: '4px solid transparent',
            borderTop: `5px solid ${colors.now}`
        });
    }

    _buildTimeAxis(scene) {
        const p = this._pools;
        const colors = scene.config.colors;
        const v = scene.viewport;
        const startX = v.axisWidth;

        applyStyle(this._timeAxis, {
            left: px(startX),
            top: '0',
            width: px(Math.max(0, v.width - startX)),
            height: px(v.axisHeight),
            background: colors.axisBg,
            borderBottom: `1px solid ${colors.axisBorder}`
        });
        // Children are positioned in viewport coordinates; shift them back.
        applyStyle(this._timeAxisInner, { left: px(-startX) });

        // Divider between the date row and the hour row, then the day separators.
        this._rect(p.axisLines, startX, v.dateRowHeight, v.width - startX, 1, colors.axisBorder);
        for (const day of scene.days) {
            if (day.sepX != null) {
                this._rect(p.axisLines, day.sepX, 0, 1, v.dateRowHeight, colors.axisBorder);
            }
        }
        for (const day of scene.days) {
            if (day.label != null) {
                this._text(p.axisDayLabels, day.label, day.labelX, day.labelY,
                    scene.config.dateLabelFont, colors.dateLabel, 'left', 'middle');
            }
        }

        for (const tick of scene.hourTicks) {
            this._rect(p.axisTicks, tick.x, v.axisHeight - 8, 1, 8, colors.tick);
        }
        for (const tick of scene.hourTicks) {
            this._text(p.axisTickLabels, tick.label, tick.x, tick.labelY,
                scene.config.hourLabelFont, colors.label, 'center', 'middle');
        }
    }

    _buildResourceAxis(scene) {
        const p = this._pools;
        const c = scene.config;
        const colors = c.colors;
        const v = scene.viewport;
        const startY = v.axisHeight;

        applyStyle(this._resourceAxis, {
            left: '0',
            top: px(startY),
            width: px(v.axisWidth),
            height: px(Math.max(0, v.height - startY)),
            background: colors.axisBg,
            borderRight: `1px solid ${colors.axisBorder}`
        });
        applyStyle(this._resourceAxisInner, { top: px(-startY) });

        // When the HTML resource-column template overlay is active it renders
        // the labels/chevrons; only the axis background/border is painted.
        if (!scene.resourceRows) return;

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

    // Marquee and edit ghost live in a clip container over the content area so
    // they never overlap the sticky axes.
    _buildOverlays(scene) {
        const rects = this._pools.overlayRects;
        const c = scene.config;
        const colors = c.colors;
        const v = scene.viewport;

        if (!scene.marquee && !scene.ghost) {
            applyStyle(this._overlayClip, { display: 'none' });
            return;
        }

        applyStyle(this._overlayClip, {
            display: '',
            left: px(v.axisWidth),
            top: px(v.axisHeight),
            width: px(Math.max(0, v.width - v.axisWidth)),
            height: px(Math.max(0, v.height - v.axisHeight))
        });
        applyStyle(this._overlayInner, { left: px(-v.axisWidth), top: px(-v.axisHeight) });

        const m = scene.marquee;
        if (m) {
            this._rect(rects, m.x, m.y, m.width, m.height,
                colors.selectionFill, `1px solid ${colors.selectionBorder}`);
        }

        const g = scene.ghost;
        if (g) {
            this._rect(rects, g.x, g.y, g.width, g.height, g.color, null, 0.7);
            this._rect(rects, g.x, g.y - 1, g.width, g.height + 2,
                null, `1px dashed ${colors.barSelectedBorder}`);
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
