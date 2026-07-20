namespace BlazorResourceTimeline.Components;

/// <summary>
/// Layout dimensions (in pixels) reported by the renderer.
/// <see cref="ResourceHeight"/> is the minimum row height; individual rows may
/// grow taller when overlapping bars stack (see the per-row height on resource overlays).
/// </summary>
public readonly record struct BlazorResourceTimelineLayout(
    int ResourceAxisWidth, int TimeAxisHeight, int ResourceHeight, int ResourceIndent = 16);
