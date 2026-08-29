using System.Text.Json.Serialization;

namespace BlazorResourceTimeline;

/// <summary>
/// What a pointer drag on empty content (no bar hit) does while editing.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum BlazorResourceTimelineEmptyDragAction
{
    /// <summary>Rubber-band selection (the default; no breaking change).</summary>
    Marquee,

    /// <summary>
    /// Draw a new allocation. Requires <see cref="BlazorResourceTimelineOptions.Editable"/>
    /// and an <c>OnAllocationCreating</c> handler. Ctrl/Cmd-drag still marquees.
    /// </summary>
    Create
}
