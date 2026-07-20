// Hover tooltip for the timeline.
//
// Owns a single position:fixed element appended to <body>, reused across
// hovers, plus the show-delay timer and the flip-at-the-viewport-edge
// positioning. Kept out of the engine because none of it depends on timeline
// state: the engine decides *what* is hovered, this decides how it is shown.
//
// The element lives on <body> rather than inside the timeline so it is never
// clipped by the scroll container or the sticky axes.

export class Tooltip {
    // `style` supplies the presentation the engine's config controls:
    // { font, background, color }.
    constructor(style) {
        this.style = style;
        this._el = null;
        this._timer = null;
        this._visible = false;
        // The subject currently described. Compared by identity so moving
        // within one bar does not rebuild or re-arm anything.
        this._subject = null;
        this._content = '';
        this._clientX = 0;
        this._clientY = 0;
    }

    // Follows the pointer. Cheap; safe to call on every move.
    trackPointer(clientX, clientY) {
        this._clientX = clientX;
        this._clientY = clientY;
    }

    // Shows `content` for `subject` after `delayMs`. Moving to a different
    // subject while a tooltip is already up swaps it immediately, which reads
    // better than making the user wait out the delay again.
    show(subject, content, delayMs) {
        if (subject === this._subject) {
            if (this._visible) this._position();
            return;
        }
        this._subject = subject;
        this._content = content;
        if (this._visible) {
            this._render();
        } else {
            clearTimeout(this._timer);
            this._timer = setTimeout(() => this._render(), delayMs || 0);
        }
    }

    hide() {
        clearTimeout(this._timer);
        this._timer = null;
        this._subject = null;
        this._content = '';
        if (this._visible && this._el) {
            this._el.style.display = 'none';
        }
        this._visible = false;
    }

    dispose() {
        clearTimeout(this._timer);
        this._timer = null;
        if (this._el) {
            this._el.remove();
            this._el = null;
        }
        this._visible = false;
        this._subject = null;
    }

    _ensureElement() {
        if (this._el) return this._el;
        const el = document.createElement('div');
        const s = el.style;
        s.position = 'fixed';
        s.zIndex = '2147483647';
        s.pointerEvents = 'none';
        s.maxWidth = '320px';
        s.padding = '6px 8px';
        s.borderRadius = '4px';
        s.font = this.style.font;
        s.lineHeight = '1.35';
        s.whiteSpace = 'pre-line';
        s.background = this.style.background;
        s.color = this.style.color;
        s.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.25)';
        s.display = 'none';
        document.body.appendChild(el);
        this._el = el;
        return el;
    }

    _render() {
        if (!this._content) return;
        const el = this._ensureElement();
        el.textContent = this._content;
        el.style.display = 'block';
        this._visible = true;
        this._position();
    }

    // Positions near the pointer, flipping to the opposite side when it would
    // overflow the viewport.
    _position() {
        const el = this._el;
        if (!el) return;
        const pad = 12;
        const rect = el.getBoundingClientRect();
        let left = this._clientX + pad;
        let top = this._clientY + pad;
        if (left + rect.width > window.innerWidth - 4) left = this._clientX - rect.width - pad;
        if (top + rect.height > window.innerHeight - 4) top = this._clientY - rect.height - pad;
        el.style.left = Math.max(4, left) + 'px';
        el.style.top = Math.max(4, top) + 'px';
    }
}
