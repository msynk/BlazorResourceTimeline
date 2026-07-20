// Hover tooltip. Runs against a minimal DOM stub rather than a real browser -
// enough to assert the show-delay, subject switching and edge flipping, which
// is where the behaviour actually lives.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Tooltip } from '../../src/BlazorResourceTimeline/wwwroot/tooltip.js';

// Minimal document/window stub. The tooltip only creates one div, appends it to
// body, writes styles and measures itself.
function installDom({ width = 1000, height = 800, boxW = 100, boxH = 40 } = {}) {
    const body = { children: [] };
    const made = [];

    globalThis.document = {
        createElement() {
            const el = {
                style: {},
                textContent: '',
                remove() {
                    const i = body.children.indexOf(el);
                    if (i >= 0) body.children.splice(i, 1);
                },
                getBoundingClientRect: () => ({ width: boxW, height: boxH })
            };
            made.push(el);
            return el;
        },
        body: {
            appendChild(el) { body.children.push(el); }
        }
    };
    globalThis.window = { innerWidth: width, innerHeight: height };

    return { body, made };
}

function uninstallDom() {
    delete globalThis.document;
    delete globalThis.window;
}

const STYLE = { font: '11px sans-serif', background: '#212529', color: '#fff' };

// The tooltip schedules through setTimeout; give the timer a chance to run.
const tick = (ms) => new Promise(r => setTimeout(r, ms));

test('nothing is added to the document until a tooltip is actually shown', () => {
    const { body } = installDom();
    try {
        const tip = new Tooltip(STYLE);
        tip.trackPointer(10, 10);
        assert.equal(body.children.length, 0, 'a timeline that is never hovered adds no element');
    } finally {
        uninstallDom();
    }
});

test('the tooltip appears only after the configured delay', async () => {
    const { body } = installDom();
    try {
        const tip = new Tooltip(STYLE);
        tip.trackPointer(100, 100);
        tip.show({ id: 'a' }, 'Bar A', 40);

        assert.equal(body.children.length, 0, 'must not appear before the delay elapses');
        await tick(80);
        assert.equal(body.children.length, 1);
        assert.equal(body.children[0].textContent, 'Bar A');
        assert.equal(body.children[0].style.display, 'block');
        tip.dispose();
    } finally {
        uninstallDom();
    }
});

test('hiding before the delay elapses cancels the pending show', async () => {
    const { body } = installDom();
    try {
        const tip = new Tooltip(STYLE);
        tip.trackPointer(100, 100);
        tip.show({ id: 'a' }, 'Bar A', 40);
        tip.hide();

        await tick(80);
        assert.equal(body.children.length, 0, 'a cancelled tooltip must never appear');
        tip.dispose();
    } finally {
        uninstallDom();
    }
});

test('moving to another bar while visible swaps content immediately', async () => {
    const { body } = installDom();
    try {
        const tip = new Tooltip(STYLE);
        tip.trackPointer(100, 100);
        tip.show({ id: 'a' }, 'Bar A', 10);
        await tick(40);
        assert.equal(body.children[0].textContent, 'Bar A');

        tip.show({ id: 'b' }, 'Bar B', 10000);
        assert.equal(body.children[0].textContent, 'Bar B',
            'already-visible tooltips should not re-serve the delay');
        tip.dispose();
    } finally {
        uninstallDom();
    }
});

test('re-showing the same subject does not restart the delay', async () => {
    const { body, made } = installDom();
    try {
        const tip = new Tooltip(STYLE);
        const subject = { id: 'a' };
        tip.trackPointer(100, 100);
        tip.show(subject, 'Bar A', 30);
        await tick(10);
        tip.show(subject, 'Bar A', 30);   // same subject, part-way through
        await tick(40);
        assert.equal(body.children.length, 1, 'the original timer should still have fired');
        assert.equal(made.length, 1, 'only one element is ever created');
        tip.dispose();
    } finally {
        uninstallDom();
    }
});

test('the tooltip flips to the other side near the viewport edges', async () => {
    const { body } = installDom({ width: 500, height: 400, boxW: 120, boxH: 50 });
    try {
        const tip = new Tooltip(STYLE);
        tip.trackPointer(40, 40);
        tip.show({ id: 'a' }, 'x', 0);
        await tick(20);
        // Room to the bottom-right: offset from the pointer.
        assert.equal(body.children[0].style.left, '52px');
        assert.equal(body.children[0].style.top, '52px');

        // Near the bottom-right corner it must flip rather than overflow.
        tip.trackPointer(480, 380);
        tip.show({ id: 'b' }, 'y', 0);
        const left = parseFloat(body.children[0].style.left);
        const top = parseFloat(body.children[0].style.top);
        assert.ok(left + 120 <= 500, `tooltip overflows the right edge (left ${left})`);
        assert.ok(top + 50 <= 400, `tooltip overflows the bottom edge (top ${top})`);
        tip.dispose();
    } finally {
        uninstallDom();
    }
});

test('the tooltip never positions itself off the top-left edge', async () => {
    const { body } = installDom({ width: 200, height: 150, boxW: 190, boxH: 140 });
    try {
        const tip = new Tooltip(STYLE);
        tip.trackPointer(5, 5);
        tip.show({ id: 'a' }, 'big', 0);
        await tick(20);
        assert.ok(parseFloat(body.children[0].style.left) >= 4);
        assert.ok(parseFloat(body.children[0].style.top) >= 4);
        tip.dispose();
    } finally {
        uninstallDom();
    }
});

test('dispose removes the element and cancels any pending show', async () => {
    const { body } = installDom();
    try {
        const tip = new Tooltip(STYLE);
        tip.trackPointer(10, 10);
        tip.show({ id: 'a' }, 'Bar A', 0);
        await tick(20);
        assert.equal(body.children.length, 1);

        tip.dispose();
        assert.equal(body.children.length, 0);

        // A show queued right before disposal must not resurrect an element.
        tip.show({ id: 'b' }, 'Bar B', 5);
        tip.dispose();
        await tick(30);
        assert.equal(body.children.length, 0);
    } finally {
        uninstallDom();
    }
});
