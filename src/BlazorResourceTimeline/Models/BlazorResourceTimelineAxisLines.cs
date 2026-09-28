using System.Text.Json.Serialization;

namespace BlazorResourceTimeline;

/// <summary>
/// Colors the grid lines that bound time columns and resource rows. Assign to
/// <see cref="BlazorResourceTimelineOptions.AxisLines"/>. A new instance replaces
/// the previous one entirely; an empty instance clears it. Lines without a
/// color keep <see cref="BlazorResourceTimelineColors.Grid"/>. Day separators on
/// the time axis use the vertical color of that midnight, and a horizontal line
/// is also drawn across the resource column when a row has its own line color.
/// Visual only.
/// </summary>
public class BlazorResourceTimelineAxisLines
{
    /// <summary>
    /// Colors for vertical lines, chosen the same way as surface column stripes:
    /// by day, hour, or week, continuously or restarting each day or week.
    /// Every vertical grid line takes the color of the stripe it sits in.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public BlazorResourceTimelineColumnStripes? Vertical { get; set; }

    /// <summary>
    /// Colors for horizontal lines, one per resource row, cycling
    /// <see cref="BlazorResourceTimelineRowStripes.Colors"/> down the row list.
    /// The line is the top edge of that row.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public BlazorResourceTimelineRowStripes? Horizontal { get; set; }

    /// <summary>
    /// CSS color per resource id for that row's horizontal line, when the
    /// resource does not set <see cref="BlazorResourceTimelineResource.LineColor"/>.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, string>? ResourceColors { get; set; }

    /// <summary>
    /// When <c>true</c>, only the line at the start of each vertical stripe is
    /// recolored (midnight for days, the week boundary, or each hour the span
    /// covers). The other vertical grid lines keep
    /// <see cref="BlazorResourceTimelineColors.Grid"/>. <c>null</c> and
    /// <c>false</c> color every vertical grid line by the stripe it sits in.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? BoundariesOnly { get; set; }
}
