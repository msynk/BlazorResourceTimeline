using System.Text.Json.Serialization;

namespace BlazorResourceTimeline;

/// <summary>
/// A part of a <see cref="BlazorResourceTimelineAllocation"/> bar with its own
/// colors, text and icon - for example the taxi, flight and turnaround phases of
/// one rotation, or the portion of a job that has already run. Sections are drawn
/// on top of the bar, in list order, and always stay within it. They are purely
/// decorative: the whole bar remains the hit target.
/// <para>
/// Each edge is given either as a time or as a percentage of the bar's duration.
/// A time wins over a percentage for the same edge, and an edge given neither
/// way falls back to the bar's own edge, so a section with no bounds covers the
/// whole bar. Both are clamped to the bar; a section left empty is not drawn.
/// </para>
/// <para>
/// Times are absolute. Moving or resizing the bar leaves a time-bounded section
/// where it was (clipped to the bar's new span), while a percentage-bounded one
/// travels and stretches with the bar. Update the sections in
/// <c>OnAllocationChanged</c> to keep time-bounded ones in step with an edit.
/// </para>
/// </summary>
public class BlazorResourceTimelineBarSection
{
    /// <summary>
    /// Start of the section. Wins over <see cref="StartPercent"/>. Clamped to the
    /// bar's <see cref="BlazorResourceTimelineAllocation.StartTime"/>.
    /// </summary>
    [JsonConverter(typeof(NullableUnixTimeMillisecondsJsonConverter))]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public DateTimeOffset? StartTime { get; set; }

    /// <summary>
    /// End of the section. Wins over <see cref="EndPercent"/>. Clamped to the
    /// bar's <see cref="BlazorResourceTimelineAllocation.EndTime"/>.
    /// </summary>
    [JsonConverter(typeof(NullableUnixTimeMillisecondsJsonConverter))]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public DateTimeOffset? EndTime { get; set; }

    /// <summary>
    /// Start of the section as a percentage (0-100) of the bar's duration,
    /// measured from the bar's start. Used when <see cref="StartTime"/> is null.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? StartPercent { get; set; }

    /// <summary>
    /// End of the section as a percentage (0-100) of the bar's duration,
    /// measured from the bar's start. Used when <see cref="EndTime"/> is null.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? EndPercent { get; set; }

    /// <summary>
    /// CSS color filling the section. When null the bar's own fill shows through
    /// (its <see cref="BlazorResourceTimelineAllocation.Color"/>, or the theme's
    /// bar color).
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? BackgroundColor { get; set; }

    /// <summary>
    /// CSS color of a 1px border drawn just inside the section's edges. When
    /// null no border is drawn, matching the bar itself.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? BorderColor { get; set; }

    /// <summary>
    /// CSS color of the section's <see cref="Text"/>. Falls back to
    /// <see cref="BlazorResourceTimelineColors.BarLabel"/> when null.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ForegroundColor { get; set; }

    /// <summary>
    /// Optional text drawn within the section, in the bar-label font. Text that
    /// does not fit within the section (its width, or a bar shorter than the
    /// font) is not drawn - it is never cut off or allowed to spill out.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Text { get; set; }

    /// <summary>Where <see cref="Text"/> sits within the section. Defaults to <see cref="BlazorResourceTimelineBarSectionPosition.Center"/>.</summary>
    public BlazorResourceTimelineBarSectionPosition TextPosition { get; set; } = BlazorResourceTimelineBarSectionPosition.Center;

    /// <summary>
    /// Optional icon drawn within the section: an image URL or a data URI, like
    /// <see cref="BlazorResourceTimelineBarIcon.Source"/>. An icon sharing a
    /// position with the text is placed beside it, nearer the section's edge
    /// (before the text when centered). An icon that does not fit is not drawn.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Icon { get; set; }

    /// <summary>Where <see cref="Icon"/> sits within the section. Defaults to <see cref="BlazorResourceTimelineBarSectionPosition.Start"/>.</summary>
    public BlazorResourceTimelineBarSectionPosition IconPosition { get; set; } = BlazorResourceTimelineBarSectionPosition.Start;

    /// <summary>
    /// Length of the square box (in pixels) the icon is fitted within, keeping its
    /// aspect ratio. Falls back to the renderer's default icon size when null or
    /// non-positive, and shrinks to the bar's height on a shorter bar.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? IconSize { get; set; }
}
