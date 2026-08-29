namespace BlazorResourceTimeline;

/// <summary>
/// Why an allocation is being committed: a pointer/keyboard move, a resize, or
/// a create (empty-drag / keyboard insert).
/// </summary>
public enum BlazorResourceTimelineAllocationChangeKind
{
    /// <summary>The bar was moved in time and/or onto another resource.</summary>
    Move,

    /// <summary>The bar's start or end was resized.</summary>
    Resize,

    /// <summary>A new bar is being created (empty-drag or keyboard insert).</summary>
    Create
}
