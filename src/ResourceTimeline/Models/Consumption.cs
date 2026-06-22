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

    /// <summary>
    /// Optional decorative bar drawn immediately before the main bar's start edge.
    /// Shares the main bar's row and height. Commonly used to indicate a delay
    /// before the planned consumption began.
    /// </summary>
    public EdgeBar? StartBar { get; set; }

    /// <summary>
    /// Optional decorative bar drawn immediately after the main bar's end edge.
    /// Shares the main bar's row and height. Commonly used to indicate a delay
    /// after the planned consumption ended.
    /// </summary>
    public EdgeBar? EndBar { get; set; }

    /// <summary>
    /// Optional custom icons or small images rendered around the bar. Each icon
    /// can be anchored to a different position (start, end, above or below).
    /// Multiple icons sharing a position are laid out next to one another,
    /// growing away from the bar in the order they appear in the list.
    /// </summary>
    public List<BarIcon>? Icons { get; set; }
}
