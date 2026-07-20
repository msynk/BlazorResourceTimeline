// Element reuse for the retained-mode renderers (HTML and SVG).
//
// Both renderers paint a fresh scene every frame, but the scene is viewport
// culled and its shape barely changes between frames: the same bars, ticks and
// grid lines, at slightly different coordinates. Rebuilding the subtree each
// time meant thousands of createElement calls and a full tree teardown per
// frame - by far the dominant cost in those renderers.
//
// A pool keeps the elements of one container across frames. Each frame walks
// the scene in the same order and calls acquire() for each node it needs; the
// element already sitting at that position is reused when it is the right kind,
// so the common frame does no DOM construction at all and only writes the
// properties that actually changed. Surplus elements left over from a busier
// previous frame are hidden rather than removed, so they are ready to be reused
// again as soon as the scene grows back.

// One pool per homogeneous run of elements - all the grid lines, all the bar
// rects, all the hour labels. Keeping each pool to a single tag is what makes
// reuse work: a pool fed a varying mix of tags mismatches as soon as the scene
// shifts by one element, and then rebuilds most of its nodes every frame.
export class NodePool {
    // `namespace` is null for HTML elements, or the SVG namespace URI.
    // `onHide` is called for each element retired at the end of a frame, for
    // pools whose elements carry identity that must not linger (bar ids).
    constructor(parent, namespace = null, onHide = null) {
        this.parent = parent;
        this.namespace = namespace;
        this.onHide = onHide;
        this.nodes = [];
        this.used = 0;
    }

    begin() {
        this.used = 0;
    }

    // The next element of the given tag. Reuses the element already at this
    // position when the tag matches, which it does on virtually every frame;
    // otherwise creates one (replacing a mismatched element in place, so
    // document order always matches the order acquire() was called in).
    acquire(tag) {
        const index = this.used++;
        const existing = this.nodes[index];
        if (existing !== undefined && existing.__tag === tag) {
            if (existing.__hidden) {
                existing.style.display = existing.__display || '';
                existing.__hidden = false;
            }
            return existing;
        }

        const node = this.namespace
            ? document.createElementNS(this.namespace, tag)
            : document.createElement(tag);
        node.__tag = tag;

        if (existing !== undefined) {
            this.parent.replaceChild(node, existing);
            this.nodes[index] = node;
        } else {
            this.parent.appendChild(node);
            this.nodes.push(node);
        }
        return node;
    }

    // Hides whatever the previous frame used and this one did not. Hiding
    // rather than removing keeps the elements available for reuse; the pool is
    // only trimmed when the surplus is large enough to be worth reclaiming.
    end() {
        for (let i = this.used; i < this.nodes.length; i++) {
            const node = this.nodes[i];
            if (!node.__hidden) {
                node.style.display = 'none';
                node.__hidden = true;
                if (this.onHide) this.onHide(node);
            }
        }
        // A scene that shrank a lot (scrolling into empty space, collapsing a
        // large group) should not pin its peak element count forever.
        if (this.nodes.length > 64 && this.nodes.length > this.used * 4) {
            for (let i = this.used; i < this.nodes.length; i++) {
                this.parent.removeChild(this.nodes[i]);
            }
            this.nodes.length = this.used;
        }
    }

    clear() {
        for (const node of this.nodes) {
            if (node.parentNode === this.parent) this.parent.removeChild(node);
        }
        this.nodes.length = 0;
        this.used = 0;
    }
}

// Applies style properties, writing only those that changed since this element
// was last used. Unchanged writes are not free (each one touches the CSSOM and
// can invalidate style), and most properties - colours, fonts, sizes - are
// identical frame to frame while only coordinates move.
//
// Callers must pass the same set of keys for a given element every frame;
// a key that disappears is not cleared. The builders below all do.
export function applyStyle(node, next) {
    let prev = node.__style;
    if (prev === undefined) prev = node.__style = {};
    const style = node.style;
    for (const key in next) {
        const value = next[key];
        if (prev[key] !== value) {
            style[key] = value;
            prev[key] = value;
        }
    }
}

// Same idea for SVG presentation attributes.
export function applyAttrs(node, next) {
    let prev = node.__attrs;
    if (prev === undefined) prev = node.__attrs = {};
    for (const key in next) {
        const value = next[key];
        if (prev[key] !== value) {
            node.setAttribute(key, value);
            prev[key] = value;
        }
    }
}

// Text content changes far less often than position; skip the write when it
// matches, since assigning textContent tears down and rebuilds the text node.
export function setText(node, text) {
    if (node.__text !== text) {
        node.textContent = text;
        node.__text = text;
    }
}
