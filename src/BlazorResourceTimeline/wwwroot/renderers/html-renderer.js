// HTML renderer for the BlazorResourceTimeline engine: renders the scene built
// by the engine (see timeline-engine.js for the renderer contract and scene
// shape) as absolutely-positioned DOM elements rebuilt each frame. The scene
// is already culled to the viewport, so the element count stays bounded by
// what is visible.
//
// Compared to canvas, HTML output is styleable with plain CSS (each bar is a
// real element carrying its allocation id in data-bar-id), inspectable in
// devtools and naturally crisp at any DPR. Canvas remains faster for very
// dense scenes.
//
// All children are pointer-events: none (inherited from the layer roots), so
// pointer interaction flows to the surface element exactly as with the other
// renderers and the engine's geometric hit-testing stays authoritative.

function div(className, style) {
    const node = document.createElement('div');
    if (className) node.className = className;
    Object.assign(node.style, style);
    return node;
}

function px(value) {
    return value + 'px';
}

// Positioned rectangle (bars, backgrounds, lines).
function rectDiv(x, y, width, height, style) {
    return div(null, {
        position: 'absolute',
        left: px(x),
        top: px(y),
        width: px(Math.max(0, width)),
        height: px(Math.max(0, height)),
        ...style
    });
}

// Maps the scene's canvas-style align/baseline onto CSS transforms so the
// (x, y) anchor matches canvas text positioning.
const ALIGN_TX = { left: '0', center: '-50%', right: '-100%' };
const BASELINE_TY = { top: '0', middle: '-50%', bottom: '-100%' };

function textDiv(content, x, y, font, color, align, baseline, bold) {
    const node = div(null, {
        position: 'absolute',
        left: px(x),
        top: px(y),
        transform: `translate(${ALIGN_TX[align] || '0'}, ${BASELINE_TY[baseline] || '0'})`,
        font: font,
        fontWeight: bold ? 'bold' : '',
        color: color,
        whiteSpace: 'nowrap',
        lineHeight: '1'
    });
    node.textContent = content;
    return node;
}

export class HtmlRenderer {
    constructor(wrapper, host) {
        this.wrapper = wrapper;
        this.host = host;

        this.surface = div('timeline-surface', {
            overflow: 'hidden'
        });
        wrapper.appendChild(this.surface);

        // Single frame root, replaced every render. Children never receive
        // pointer events; the surface is the interaction target.
        this._frame = div(null, {
            position: 'absolute',
            inset: '0',
            pointerEvents: 'none'
        });
        this.surface.appendChild(this._frame);
    }

    resize(cssW, cssH) {
        this.surface.style.width = px(cssW);
        this.surface.style.height = px(cssH);
    }

    render(scene) {
        const next = div(null, {
            position: 'absolute',
            inset: '0',
            pointerEvents: 'none'
        });

        this._buildBackground(scene, next);
        this._buildGrid(scene, next);
        this._buildBars(scene, next);
        this._buildNowLine(scene, next);
        this._buildTimeAxis(scene, next);
        this._buildResourceAxis(scene, next);
        this._buildOverlays(scene, next);

        this._frame.replaceWith(next);
        this._frame = next;
    }

    _buildBackground(scene, root) {
        const colors = scene.config.colors;
        const v = scene.viewport;
        const contentWidth = v.width - v.axisWidth;
        const contentHeight = v.height - v.axisHeight;

        root.appendChild(rectDiv(v.axisWidth, v.axisHeight, contentWidth, contentHeight,
            { background: colors.contentBg }));
        root.appendChild(rectDiv(0, 0, v.axisWidth, v.axisHeight, { background: colors.axisBg }));
        root.appendChild(rectDiv(0, v.axisHeight, v.axisWidth, contentHeight, { background: colors.axisBg }));
        root.appendChild(rectDiv(v.axisWidth, 0, contentWidth, v.axisHeight, { background: colors.axisBg }));
    }

    _buildGrid(scene, root) {
        const grid = scene.config.colors.grid;
        const v = scene.viewport;
        for (const y of scene.gridH) {
            root.appendChild(rectDiv(v.axisWidth, y, v.width - v.axisWidth, 1, { background: grid }));
        }
        for (const x of scene.gridV) {
            root.appendChild(rectDiv(x, v.axisHeight, 1, v.height - v.axisHeight, { background: grid }));
        }
    }

    _buildBars(scene, root) {
        const c = scene.config;

        for (const bar of scene.bars) {
            if (bar.edges) {
                for (const edge of bar.edges) {
                    root.appendChild(rectDiv(edge.x, edge.y, edge.width, edge.height,
                        { background: edge.color }));
                }
            }

            const barEl = rectDiv(bar.x, bar.y, bar.width, bar.height, { background: bar.color });
            barEl.dataset.barId = bar.id;
            root.appendChild(barEl);

            // A 2px stroke centered on the rect covers one extra pixel on each
            // side; a border-box div grown by 1px per side matches that.
            if (bar.outline) {
                root.appendChild(rectDiv(
                    bar.outline.x - 1, bar.outline.y - 1,
                    bar.outline.width + 2, bar.outline.height + 2, {
                        boxSizing: 'border-box',
                        border: `2px solid ${c.colors.barSelectedBorder}`
                    }));
            }

            if (bar.focusRing) {
                root.appendChild(rectDiv(
                    bar.focusRing.x - 1, bar.focusRing.y - 1,
                    bar.focusRing.width + 2, bar.focusRing.height + 2, {
                        boxSizing: 'border-box',
                        border: `2px dashed ${c.colors.focus}`
                    }));
            }

            if (bar.icons) {
                for (const icon of bar.icons) {
                    const img = document.createElement('img');
                    img.src = icon.source;
                    img.alt = '';
                    Object.assign(img.style, {
                        position: 'absolute',
                        left: px(icon.x),
                        top: px(icon.y),
                        width: px(icon.width),
                        height: px(icon.height)
                    });
                    root.appendChild(img);
                }
            }

            if (bar.labels) {
                for (const label of bar.labels) {
                    root.appendChild(textDiv(label.text, label.x, label.y,
                        c.barLabelFont, c.colors.barLabel, label.align, label.baseline));
                }
            }
        }
    }

    _buildNowLine(scene, root) {
        if (scene.nowX == null) return;
        const colors = scene.config.colors;
        const v = scene.viewport;
        const x = scene.nowX;

        root.appendChild(rectDiv(x - 1, v.axisHeight, 2, v.height - v.axisHeight,
            { background: colors.now }));
        // Small triangular marker at the top of the line (CSS border triangle).
        root.appendChild(div(null, {
            position: 'absolute',
            left: px(x - 4),
            top: px(v.axisHeight),
            width: '0',
            height: '0',
            borderLeft: '4px solid transparent',
            borderRight: '4px solid transparent',
            borderTop: `5px solid ${colors.now}`
        }));
    }

    _buildTimeAxis(scene, root) {
        const colors = scene.config.colors;
        const v = scene.viewport;
        const startX = v.axisWidth;

        // Axis surface, clipping its own labels/separators.
        const axis = rectDiv(startX, 0, v.width - startX, v.axisHeight, {
            background: colors.axisBg,
            borderBottom: `1px solid ${colors.axisBorder}`,
            boxSizing: 'border-box',
            overflow: 'hidden'
        });
        // Children are positioned in viewport coordinates; shift them back.
        const inner = div(null, { position: 'absolute', left: px(-startX), top: '0' });
        axis.appendChild(inner);
        root.appendChild(axis);

        // Divider between the date row and the hour row.
        inner.appendChild(rectDiv(startX, v.dateRowHeight, v.width - startX, 1,
            { background: colors.axisBorder }));

        for (const day of scene.days) {
            if (day.sepX != null) {
                inner.appendChild(rectDiv(day.sepX, 0, 1, v.dateRowHeight,
                    { background: colors.axisBorder }));
            }
            if (day.label != null) {
                inner.appendChild(textDiv(day.label, day.labelX, day.labelY,
                    '12px sans-serif', colors.dateLabel, 'left', 'middle'));
            }
        }

        for (const tick of scene.hourTicks) {
            inner.appendChild(rectDiv(tick.x, v.axisHeight - 8, 1, 8, { background: colors.tick }));
            inner.appendChild(textDiv(tick.label, tick.x, tick.labelY,
                '12px sans-serif', colors.label, 'center', 'middle'));
        }
    }

    _buildResourceAxis(scene, root) {
        const colors = scene.config.colors;
        const v = scene.viewport;
        const startY = v.axisHeight;

        // Axis surface, clipping long labels at the divider.
        const axis = rectDiv(0, startY, v.axisWidth, v.height - startY, {
            background: colors.axisBg,
            borderRight: `1px solid ${colors.axisBorder}`,
            boxSizing: 'border-box',
            overflow: 'hidden'
        });
        const inner = div(null, { position: 'absolute', left: '0', top: px(-startY) });
        axis.appendChild(inner);
        root.appendChild(axis);

        // When the HTML resource-column template overlay is active it renders
        // the labels/chevrons; only the axis background/border is painted.
        if (!scene.resourceRows) return;

        for (const row of scene.resourceRows) {
            if (row.hasChildren) {
                inner.appendChild(textDiv(row.collapsed ? '▶' : '▼', row.leftPad, row.midY,
                    '10px sans-serif', colors.label, 'left', 'middle'));
                inner.appendChild(textDiv(row.name, row.leftPad + 14, row.midY,
                    '13px sans-serif', colors.dateLabel, 'left', 'middle', true));
            } else {
                inner.appendChild(textDiv(row.name, row.leftPad, row.midY,
                    '13px sans-serif', colors.label, 'left', 'middle'));
            }
        }
    }

    // Marquee and edit ghost live in a clip container over the content area so
    // they never overlap the sticky axes.
    _buildOverlays(scene, root) {
        if (!scene.marquee && !scene.ghost) return;
        const c = scene.config;
        const colors = c.colors;
        const v = scene.viewport;

        const clip = rectDiv(v.axisWidth, v.axisHeight,
            v.width - v.axisWidth, v.height - v.axisHeight, { overflow: 'hidden' });
        const inner = div(null, {
            position: 'absolute',
            left: px(-v.axisWidth),
            top: px(-v.axisHeight)
        });
        clip.appendChild(inner);
        root.appendChild(clip);

        const m = scene.marquee;
        if (m) {
            inner.appendChild(rectDiv(m.x, m.y, m.width, m.height, {
                background: colors.selectionFill,
                boxSizing: 'border-box',
                border: `1px solid ${colors.selectionBorder}`
            }));
        }

        const g = scene.ghost;
        if (g) {
            inner.appendChild(rectDiv(g.x, g.y, g.width, g.height, {
                background: g.color,
                opacity: '0.7'
            }));
            inner.appendChild(rectDiv(g.x, g.y - 1, g.width, g.height + 2, {
                boxSizing: 'border-box',
                border: `1px dashed ${colors.barSelectedBorder}`
            }));
            // Time readout above the ghost for precise feedback while dragging.
            if (g.label) {
                inner.appendChild(textDiv(g.label, g.x, g.y - 2,
                    c.barLabelFont, colors.dateLabel, 'left', 'bottom'));
            }
        }
    }

    dispose() {
        this.surface.remove();
    }
}
