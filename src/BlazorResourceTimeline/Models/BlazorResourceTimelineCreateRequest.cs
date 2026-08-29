namespace BlazorResourceTimeline;

/// <summary>
/// A proposed new allocation from an empty-content drag (or keyboard insert).
/// The host must assign <see cref="BlazorResourceTimelineAllocation.Id"/> and
/// return the full bar, or return <c>null</c> to cancel.
/// </summary>
public sealed class BlazorResourceTimelineCreateRequest
{
    /// <summary>Resource row the new bar should belong to.</summary>
    public required string ResourceId { get; init; }

    /// <summary>Snapped start of the drawn range.</summary>
    public DateTimeOffset StartTime { get; init; }

    /// <summary>Snapped end of the drawn range (at least <c>EditMinDurationMinutes</c>).</summary>
    public DateTimeOffset EndTime { get; init; }
}
