namespace BlazorResourceTimeline.Components;

/// <summary>Fixed layout dimensions (in pixels) reported by the renderer.</summary>
public readonly record struct BlazorResourceTimelineLayout(
    int ResourceAxisWidth, int TimeAxisHeight, int ResourceHeight, int ResourceIndent = 16);
