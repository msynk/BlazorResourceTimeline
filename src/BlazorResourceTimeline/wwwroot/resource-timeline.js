// Entry point for the BlazorResourceTimeline Blazor component.
//
// The timeline is split into a rendering-agnostic engine (timeline-engine.js:
// data, interaction, layout math, interop) and pluggable renderers that paint
// the scene the engine builds each frame (renderers/*.js). This module wires
// the two together and exposes the factory used by the .razor component
// through JS interop.

import { TimelineEngine } from './timeline-engine.js';
import { CanvasRenderer } from './renderers/canvas-renderer.js';
import { SvgRenderer } from './renderers/svg-renderer.js';
import { HtmlRenderer } from './renderers/html-renderer.js';

// Renderer registry, keyed by the (lowercased) `renderer` option. The engine
// falls back to canvas for unknown names.
const RENDERERS = {
    canvas: CanvasRenderer,
    svg: SvgRenderer,
    html: HtmlRenderer
};

// Creates a timeline inside the given wrapper (scroll viewport) element. The
// active renderer creates its own surface element within the wrapper and can
// be switched at runtime via setOptions({ renderer: ... }).
export function createTimeline(wrapper, dotNetRef, options) {
    return new TimelineEngine(wrapper, dotNetRef, options, RENDERERS);
}
