using BlazorResourceTimeline.Models;

namespace BlazorResourceTimeline.Demo.Data;

/// <summary>
/// Convenience bundle returned by <see cref="DataGenerator"/> that carries
/// everything the timeline needs to render.
/// </summary>
public class TimelineData
{
    public required List<Resource> Resources { get; set; }
    public required TimeRange TimeRange { get; set; }
    public required List<Consumption> Consumptions { get; set; }
}
