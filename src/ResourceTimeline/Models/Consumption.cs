namespace ResourceTimeline.Models;

/// <summary>
/// A single consumption period drawn as a bar on a resource row.
/// Times are expressed as Unix time in milliseconds to match the canvas renderer.
/// </summary>
public class Consumption
{
    /// <summary>Unique identifier for the consumption bar.</summary>
    public required string Id { get; set; }

    /// <summary>Identifier of the owning <see cref="Resource"/>.</summary>
    public required string ResourceId { get; set; }

    /// <summary>Start of the period as Unix time in milliseconds.</summary>
    public long StartTime { get; set; }

    /// <summary>End of the period as Unix time in milliseconds.</summary>
    public long EndTime { get; set; }

    /// <summary>
    /// Optional CSS color for the bar fill (for example <c>"#e8590c"</c> or <c>"tomato"</c>).
    /// Falls back to the renderer's default bar color when null or empty.
    /// </summary>
    public string? Color { get; set; }

    /// <summary>Optional label rendered centered above the bar.</summary>
    public string? TextAbove { get; set; }

    /// <summary>Optional label rendered centered below the bar.</summary>
    public string? TextBelow { get; set; }

    /// <summary>Optional label rendered just before the bar's start edge.</summary>
    public string? TextStart { get; set; }

    /// <summary>Optional label rendered just after the bar's end edge.</summary>
    public string? TextEnd { get; set; }
}
