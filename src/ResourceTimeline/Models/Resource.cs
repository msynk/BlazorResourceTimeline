namespace ResourceTimeline.Models;

/// <summary>
/// A single row on the timeline (for example a server, database or worker).
/// </summary>
public class Resource
{
    /// <summary>Stable identifier used to associate consumptions with this resource.</summary>
    public required string Id { get; set; }

    /// <summary>Display label rendered on the sticky resource axis.</summary>
    public required string Name { get; set; }
}
