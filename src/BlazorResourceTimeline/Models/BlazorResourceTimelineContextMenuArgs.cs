namespace BlazorResourceTimeline.Models;

/// <summary>
/// Describes a right-click on the timeline: what was under the pointer and
/// where on screen the click happened, so the host can show and position its
/// own context menu (the native browser menu is suppressed).
/// </summary>
public sealed class BlazorResourceTimelineContextMenuArgs
{
    /// <summary>
    /// The bar under the pointer, or <c>null</c> when the click did not hit a
    /// bar. The same instance supplied in the config, so it can be compared by
    /// reference against the caller's own data.
    /// </summary>
    public BlazorResourceTimelineAllocation? Allocation { get; init; }

    /// <summary>
    /// The resource row under the pointer — set for clicks on bars, on empty
    /// content slots and on resource-axis rows; <c>null</c> below the last row.
    /// </summary>
    public BlazorResourceTimelineResource? Resource { get; init; }

    /// <summary>
    /// The time at the pointer's horizontal position, or <c>null</c> when the
    /// click was on the resource axis (which has no time coordinate).
    /// </summary>
    public DateTimeOffset? Time { get; init; }

    /// <summary>Pointer X in viewport coordinates, suited for a <c>position: fixed</c> menu.</summary>
    public double ClientX { get; init; }

    /// <summary>Pointer Y in viewport coordinates, suited for a <c>position: fixed</c> menu.</summary>
    public double ClientY { get; init; }
}
