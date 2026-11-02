using System.Text.Json.Serialization;

namespace BlazorResourceTimeline;

/// <summary>
/// Where the text or icon of a <see cref="BlazorResourceTimelineBarSection"/> sits
/// within that section.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum BlazorResourceTimelineBarSectionPosition
{
    /// <summary>Just inside the section's start edge.</summary>
    Start,

    /// <summary>Centered horizontally within the section.</summary>
    Center,

    /// <summary>Just inside the section's end edge.</summary>
    End
}
