namespace BlazorResourceTimeline.Models;

/// <summary>
/// Inclusive time window rendered along the horizontal axis,
/// expressed as Unix time in milliseconds.
/// </summary>
public class BlazorResourceTimelineTimeRange
{
    public long Start { get; set; }
    public long End { get; set; }
}
