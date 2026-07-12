namespace BlazorResourceTimeline.Models;

/// <summary>
/// A small custom icon or image rendered next to a <see cref="BlazorResourceTimelineAllocation"/> bar.
/// Multiple icons can be attached to a single bar and placed at different
/// positions. Icons are purely decorative (not selectable). Each icon is
/// scaled to fit inside a square box (see <see cref="Size"/>) while preserving
/// its aspect ratio.
/// </summary>
public class BlazorResourceTimelineBarIcon
{
    /// <summary>
    /// Image source: an absolute or app-relative URL (for example
    /// <c>"/icons/warning.png"</c>) or a data URI (for example
    /// <c>"data:image/svg+xml;base64,…"</c>). Required.
    /// </summary>
    public required string Source { get; set; }

    /// <summary>Where the icon is anchored relative to the bar. Defaults to <see cref="BlazorResourceTimelineBarIconPosition.Start"/>.</summary>
    public BlazorResourceTimelineBarIconPosition Position { get; set; } = BlazorResourceTimelineBarIconPosition.Start;

    /// <summary>
    /// Length of the square box (in pixels) the icon is drawn within. The image
    /// is scaled to fit while keeping its aspect ratio. Falls back to the
    /// renderer's default icon size when null or non-positive.
    /// </summary>
    public int? Size { get; set; }
}
