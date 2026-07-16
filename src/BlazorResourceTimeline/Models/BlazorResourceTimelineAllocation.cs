using System.Text.Json.Serialization;
using BlazorResourceTimeline.Json;

namespace BlazorResourceTimeline.Models;

/// <summary>
/// A single allocation period drawn as a bar on a resource row.
/// </summary>
public class BlazorResourceTimelineAllocation
{
    /// <summary>Unique identifier for the allocation bar.</summary>
    public required string Id { get; set; }

    /// <summary>Identifier of the owning <see cref="BlazorResourceTimelineResource"/>.</summary>
    public required string ResourceId { get; set; }

    /// <summary>Start of the period.</summary>
    [JsonConverter(typeof(UnixTimeMillisecondsJsonConverter))]
    public DateTimeOffset StartTime { get; set; }

    /// <summary>End of the period.</summary>
    [JsonConverter(typeof(UnixTimeMillisecondsJsonConverter))]
    public DateTimeOffset EndTime { get; set; }

    /// <summary>
    /// Optional CSS color for the bar fill (for example <c>"#e8590c"</c> or <c>"tomato"</c>).
    /// Falls back to the renderer's default bar color when null or empty.
    /// </summary>
    public string? Color { get; set; }

    /// <summary>
    /// Optional height of the bar in pixels. The bar is vertically centered within
    /// its resource row regardless of height. Falls back to the renderer's default
    /// bar height when null or not greater than zero. Any start/end edge bars share
    /// this height.
    /// </summary>
    public int? Height { get; set; }

    /// <summary>Optional label rendered centered above the bar.</summary>
    public string? TextAbove { get; set; }

    /// <summary>Optional label rendered centered below the bar.</summary>
    public string? TextBelow { get; set; }

    /// <summary>Optional label rendered just before the bar's start edge.</summary>
    public string? TextStart { get; set; }

    /// <summary>Optional label rendered just after the bar's end edge.</summary>
    public string? TextEnd { get; set; }

    /// <summary>
    /// Optional tooltip text shown when hovering the bar (requires
    /// <see cref="BlazorResourceTimelineOptions.ShowTooltips"/>). When null, a
    /// default tooltip is built from the bar's labels, resource name and time
    /// range. Use <c>"\n"</c> to separate lines.
    /// </summary>
    public string? Tooltip { get; set; }

    /// <summary>
    /// Optional decorative bar drawn immediately before the main bar's start edge.
    /// Shares the main bar's row and height. Commonly used to indicate a delay
    /// before the planned allocation began.
    /// </summary>
    public BlazorResourceTimelineEdgeBar? StartBar { get; set; }

    /// <summary>
    /// Optional decorative bar drawn immediately after the main bar's end edge.
    /// Shares the main bar's row and height. Commonly used to indicate a delay
    /// after the planned allocation ended.
    /// </summary>
    public BlazorResourceTimelineEdgeBar? EndBar { get; set; }

    /// <summary>
    /// Optional custom icons or small images rendered around the bar. Each icon
    /// can be anchored to a different position (start, end, above or below).
    /// Multiple icons sharing a position are laid out next to one another,
    /// growing away from the bar in the order they appear in the list.
    /// </summary>
    public List<BlazorResourceTimelineBarIcon>? Icons { get; set; }
}
