using System.Text.Json.Serialization;

namespace BlazorResourceTimeline.Models;

/// <summary>
/// Where a <see cref="BarIcon"/> is anchored relative to its owning
/// <see cref="Consumption"/> bar.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum BarIconPosition
{
    /// <summary>Just before the bar's start edge, vertically centered on the bar.</summary>
    Start,

    /// <summary>Just after the bar's end edge, vertically centered on the bar.</summary>
    End,

    /// <summary>Centered above the bar.</summary>
    Above,

    /// <summary>Centered below the bar.</summary>
    Below
}

/// <summary>
/// A small custom icon or image rendered next to a <see cref="Consumption"/> bar.
/// Multiple icons can be attached to a single bar and placed at different
/// positions. Icons are purely decorative (not selectable). Each icon is
/// scaled to fit inside a square box (see <see cref="Size"/>) while preserving
/// its aspect ratio.
/// </summary>
public class BarIcon
{
    /// <summary>
    /// Image source: an absolute or app-relative URL (for example
    /// <c>"/icons/warning.png"</c>) or a data URI (for example
    /// <c>"data:image/svg+xml;base64,…"</c>). Required.
    /// </summary>
    public required string Source { get; set; }

    /// <summary>Where the icon is anchored relative to the bar. Defaults to <see cref="BarIconPosition.Start"/>.</summary>
    public BarIconPosition Position { get; set; } = BarIconPosition.Start;

    /// <summary>
    /// Length of the square box (in pixels) the icon is drawn within. The image
    /// is scaled to fit while keeping its aspect ratio. Falls back to the
    /// renderer's default icon size when null or non-positive.
    /// </summary>
    public int? Size { get; set; }
}
