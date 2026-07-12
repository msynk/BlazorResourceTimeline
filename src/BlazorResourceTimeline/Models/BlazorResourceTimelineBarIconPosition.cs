using System.Text.Json.Serialization;

namespace BlazorResourceTimeline.Models;

/// <summary>
/// Where a <see cref="BlazorResourceTimelineBarIcon"/> is anchored relative to its owning
/// <see cref="BlazorResourceTimelineAllocation"/> bar.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum BlazorResourceTimelineBarIconPosition
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
