// SVG renderer for the BlazorResourceTimeline engine: renders the scene built
// by the engine (see timeline-engine.js for the renderer contract and scene
// shape) as an <svg> element rebuilt each frame. The scene is already culled
// to the viewport, so the element count stays bounded by what is visible.
//
// Compared to canvas, SVG output is resolution-independent (crisp at any
// zoom/DPR without backing-store management), styleable and inspectable in
// devtools, and copy/print friendly. Canvas remains faster for very dense
// scenes.

const SVG_NS = 'http://www.w3.org/2000/svg';

// Unique clip-path id prefix per renderer instance so multiple timelines on
// one page never collide.
let instanceCounter = 0;

function el(name, attrs) {
    const node = document.createElementNS(SVG_NS, name);
    for (const key of Object.keys(attrs)) {
        node.setAttribute(key, attrs[key]);
    }
    return node;
}

function line(x1, y1, x2, y2, stroke, width) {
    return el('line', {
        x1, y1, x2, y2,
        stroke,
        'stroke-width': width || 1,
        'shape-rendering': 'crispEdges'
    });
}

function rect(x, y, width, height, attrs) {
    return el('rect', { x, y, width, height, ...attrs });
}

// Maps the scene's canvas-style align/baseline to SVG text attributes.
const ANCHOR = { left: 'start', center: 'middle', right: 'end' };
const BASELINE = { top: 'hanging', middle: 'central', bottom: 'auto' };

function text(content, x, y, font, fill, align, baseline) {
    const node = el('text', {
        x, y, fill,
        'text-anchor': ANCHOR[align] || 'start',
        'dominant-baseline': BASELINE[baseline] || 'auto'
    });
    node.style.font = font;
    node.textContent = content;
    return node;
}

export class SvgRenderer {
    constructor(wrapper, host) {
        this.wrapper = wrapper;
        this.host = host;

        this.surface = document.createElementNS(SVG_NS, 'svg');
        this.surface.setAttribute('class', 'timeline-surface');
        wrapper.appendChild(this.surface);

        const id = ++instanceCounter;
        this._contentClipId = `brt-svg-content-clip-${id}`;
        this._axisClipId = `brt-svg-axis-clip-${id}`;

        // Persistent structure: <defs> with the two clip paths, plus a frame
        // group whose children are replaced every render.
        this._contentClipRect = rect(0, 0, 0, 0, {});
        this._axisClipRect = rect(0, 0, 0, 0, {});
        const defs = el('defs', {});
        const contentClip = el('clipPath', { id: this._contentClipId });
        contentClip.appendChild(this._contentClipRect);
        const axisClip = el('clipPath', { id: this._axisClipId });
        axisClip.appendChild(this._axisClipRect);
        defs.appendChild(contentClip);
        defs.appendChild(axisClip);
        this.surface.appendChild(defs);

        this._frame = el('g', {});
        this.surface.appendChild(this._frame);
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
        this._setRect(this._contentClipRect, v.axisWidth, v.axisHeight,
            Math.max(0, v.width - v.axisWidth), Math.max(0, v.height - v.axisHeight));
        // Axis clip: the resource column below the time axis, so long labels
        // don't bleed across the divider into the content area.
        this._setRect(this._axisClipRect, 0, v.axisHeight,
            Math.max(0, v.axisWidth - 1), Math.max(0, v.height - v.axisHeight));

        const nodes = [];
        this._buildBackground(scene, nodes);
        this._buildGrid(scene, nodes);
        this._buildBars(scene, nodes);
        this._buildNowLine(scene, nodes);
        this._buildTimeAxis(scene, nodes);
        this._buildResourceAxis(scene, nodes);
        this._buildMarquee(scene, nodes);
        this._buildGhost(scene, nodes);
        this._frame.replaceChildren(...nodes);
    }

    _setRect(node, x, y, width, height) {
        node.setAttribute('x', x);
        node.setAttribute('y', y);
        node.setAttribute('width', width);
        node.setAttribute('height', height);
    }

    _buildBackground(scene, nodes) {
        const colors = scene.config.colors;
        const v = scene.viewport;
        const contentWidth = v.width - v.axisWidth;
        const contentHeight = v.height - v.axisHeight;

        nodes.push(rect(v.axisWidth, v.axisHeight, contentWidth, contentHeight, { fill: colors.contentBg }));
        nodes.push(rect(0, 0, v.axisWidth, v.axisHeight, { fill: colors.axisBg }));
        nodes.push(rect(0, v.axisHeight, v.axisWidth, contentHeight, { fill: colors.axisBg }));
        nodes.push(rect(v.axisWidth, 0, contentWidth, v.axisHeight, { fill: colors.axisBg }));
    }

    _buildGrid(scene, nodes) {
        const grid = scene.config.colors.grid;
        const v = scene.viewport;
        for (const y of scene.gridH) {
            nodes.push(line(v.axisWidth, y, v.width, y, grid));
        }
        for (const x of scene.gridV) {
            nodes.push(line(x, v.axisHeight, x, v.height, grid));
        }
    }

    _buildBars(scene, nodes) {
        const c = scene.config;

        for (const bar of scene.bars) {
            if (bar.edges) {
                for (const edge of bar.edges) {
                    nodes.push(rect(edge.x, edge.y, edge.width, edge.height, { fill: edge.color }));
                }
            }

            nodes.push(rect(bar.x, bar.y, bar.width, bar.height, { fill: bar.color, 'data-bar-id': bar.id }));

            if (bar.outline) {
                nodes.push(rect(bar.outline.x, bar.outline.y, bar.outline.width, bar.outline.height, {
                    fill: 'none',
                    stroke: c.colors.barSelectedBorder,
                    'stroke-width': 2
                }));
            }

            if (bar.focusRing) {
                nodes.push(rect(bar.focusRing.x, bar.focusRing.y, bar.focusRing.width, bar.focusRing.height, {
                    fill: 'none',
                    stroke: c.colors.focus,
                    'stroke-width': 2,
                    'stroke-dasharray': '3 2'
                }));
            }

            if (bar.icons) {
                for (const icon of bar.icons) {
                    nodes.push(el('image', {
                        href: icon.source,
                        x: icon.x, y: icon.y,
                        width: icon.width, height: icon.height,
                        // The scene already fitted the box to the image's
                        // aspect ratio.
                        preserveAspectRatio: 'none'
                    }));
                }
            }

            if (bar.labels) {
                for (const label of bar.labels) {
                    nodes.push(text(label.text, label.x, label.y,
                        c.barLabelFont, c.colors.barLabel, label.align, label.baseline));
                }
            }
        }
    }

    _buildNowLine(scene, nodes) {
        if (scene.nowX == null) return;
        const colors = scene.config.colors;
        const v = scene.viewport;
        const x = scene.nowX;

        nodes.push(el('line', {
            x1: x, y1: v.axisHeight, x2: x, y2: v.height,
            stroke: colors.now, 'stroke-width': 2
        }));
        // Small triangular marker at the top of the line.
        nodes.push(el('path', {
            d: `M ${x - 4} ${v.axisHeight} L ${x + 4} ${v.axisHeight} L ${x} ${v.axisHeight + 5} Z`,
            fill: colors.now
        }));
    }

    _buildTimeAxis(scene, nodes) {
        const colors = scene.config.colors;
        const v = scene.viewport;
        const startX = v.axisWidth;

        nodes.push(rect(startX, 0, v.width - startX, v.axisHeight, { fill: colors.axisBg }));
        // Bottom border of the whole axis, and the date/hour row divider.
        nodes.push(line(startX, v.axisHeight, v.width, v.axisHeight, colors.axisBorder));
        nodes.push(line(startX, v.dateRowHeight, v.width, v.dateRowHeight, colors.axisBorder));

        for (const day of scene.days) {
            if (day.sepX != null) {
                nodes.push(line(day.sepX, 0, day.sepX, v.dateRowHeight, colors.axisBorder));
            }
            if (day.label != null) {
                nodes.push(text(day.label, day.labelX, day.labelY,
                    '12px sans-serif', colors.dateLabel, 'left', 'middle'));
            }
        }

        for (const tick of scene.hourTicks) {
            nodes.push(line(tick.x, v.axisHeight - 8, tick.x, v.axisHeight, colors.tick));
            nodes.push(text(tick.label, tick.x, tick.labelY,
                '12px sans-serif', colors.label, 'center', 'middle'));
        }
    }

    _buildResourceAxis(scene, nodes) {
        const colors = scene.config.colors;
        const v = scene.viewport;
        const startY = v.axisHeight;

        nodes.push(rect(0, startY, v.axisWidth, v.height - startY, { fill: colors.axisBg }));
        nodes.push(line(v.axisWidth, startY, v.axisWidth, v.height, colors.axisBorder));

        // When the HTML resource-column template overlay is active it renders
        // the labels/chevrons; only the axis background/border is painted.
        if (!scene.resourceRows) return;

        const group = el('g', { 'clip-path': `url(#${this._axisClipId})` });
        for (const row of scene.resourceRows) {
            if (row.hasChildren) {
                group.appendChild(text(row.collapsed ? '▶' : '▼', row.leftPad, row.midY,
                    '10px sans-serif', colors.label, 'left', 'middle'));
                group.appendChild(text(row.name, row.leftPad + 14, row.midY,
                    'bold 13px sans-serif', colors.dateLabel, 'left', 'middle'));
            } else {
                group.appendChild(text(row.name, row.leftPad, row.midY,
                    '13px sans-serif', colors.label, 'left', 'middle'));
            }
        }
        nodes.push(group);
    }

    _buildMarquee(scene, nodes) {
        const m = scene.marquee;
        if (!m) return;
        const colors = scene.config.colors;

        const group = el('g', { 'clip-path': `url(#${this._contentClipId})` });
        group.appendChild(rect(m.x, m.y, m.width, m.height, { fill: colors.selectionFill }));
        group.appendChild(rect(m.x + 0.5, m.y + 0.5, m.width, m.height, {
            fill: 'none',
            stroke: colors.selectionBorder,
            'stroke-width': 1
        }));
        nodes.push(group);
    }

    _buildGhost(scene, nodes) {
        const g = scene.ghost;
        if (!g) return;
        const c = scene.config;

        const group = el('g', { 'clip-path': `url(#${this._contentClipId})` });
        group.appendChild(rect(g.x, g.y, g.width, g.height, {
            fill: g.color,
            'fill-opacity': 0.7
        }));
        group.appendChild(rect(g.x + 0.5, g.y - 0.5, g.width, g.height + 1, {
            fill: 'none',
            stroke: c.colors.barSelectedBorder,
            'stroke-width': 1,
            'stroke-dasharray': '4 2'
        }));
        // Time readout above the ghost for precise feedback while dragging.
        if (g.label) {
            group.appendChild(text(g.label, g.x, g.y - 2,
                c.barLabelFont, c.colors.dateLabel, 'left', 'bottom'));
        }
        nodes.push(group);
    }

    dispose() {
        this.surface.remove();
    }
}
