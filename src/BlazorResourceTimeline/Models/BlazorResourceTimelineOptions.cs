using System.Text.Json.Serialization;

namespace BlazorResourceTimeline.Models;

/// <summary>
/// Optional visual configuration for the timeline: axis/row dimensions, bar
/// sizing, fonts and colors. Every property is nullable; those left <c>null</c>
/// keep the renderer's defaults, so a partial instance overrides only what it
/// sets. Assign to the component's <c>Options</c> parameter. Assigning a new
/// instance re-applies the options (and re-lays-out the canvas).
/// </summary>
public class BlazorResourceTimelineOptions
{
    /// <summary>Height of each resource row, in pixels.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? ResourceHeight { get; set; }

    /// <summary>Height of the time axis (both date and hour rows), in pixels.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? TimeAxisHeight { get; set; }

    /// <summary>Width of the resource axis (the left label column), in pixels.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? ResourceAxisWidth { get; set; }

    /// <summary>Height of the date row within the time axis, in pixels.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? DateRowHeight { get; set; }

    /// <summary>Default bar height used when an allocation sets no explicit height, in pixels.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? BarHeight { get; set; }

    /// <summary>Minimum drawn bar width so very short allocations stay visible, in pixels.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? MinBarWidth { get; set; }

    /// <summary>
    /// Minimum main-bar width (in pixels) for its labels and icons to be drawn.
    /// Bars narrower than this skip decorations, keeping dense timelines readable.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? MinBarWidthForLabels { get; set; }

    /// <summary>CSS font shorthand used for bar labels (for example <c>"11px sans-serif"</c>).</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? BarLabelFont { get; set; }

    /// <summary>Gap between a bar and its labels/icons, in pixels.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? BarLabelGap { get; set; }

    /// <summary>Default size of the square box a bar icon is drawn within, in pixels.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? BarIconSize { get; set; }

    /// <summary>Pointer movement (in pixels) before a press becomes a marquee drag rather than a click.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? DragThreshold { get; set; }

    /// <summary>Extra pixels around a bar's drawn extent that still register as a hit.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? HitTolerance { get; set; }

    /// <summary>
    /// IANA time zone id the time axis is drawn in — day and hour boundaries and
    /// their labels are computed in this zone (for example <c>"UTC"</c> for
    /// aviation/Zulu time, or <c>"Europe/Berlin"</c>). <c>null</c> uses the
    /// viewer's local zone. Allocation times themselves are absolute instants and
    /// are unaffected; only the axis presentation changes.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? TimeZone { get; set; }

    /// <summary>
    /// BCP 47 locale (for example <c>"de-DE"</c> or <c>"ja-JP"</c>) used to format
    /// day labels, tooltips and screen-reader announcements. <c>null</c> uses the
    /// viewer's locale. Numeric hour ticks are unaffected (always 24-hour).
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Locale { get; set; }

    /// <summary>
    /// Horizontal scale in pixels per hour. <c>null</c> auto-fits exactly one day
    /// to the viewport width. An explicit value is clamped to
    /// <see cref="MinPixelsPerHour"/>/<see cref="MaxPixelsPerHour"/>. Runtime zoom
    /// (the component's zoom methods) overrides this until reset.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? PixelsPerHour { get; set; }

    /// <summary>Lower bound for the scale when zooming, in pixels per hour.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? MinPixelsPerHour { get; set; }

    /// <summary>Upper bound for the scale when zooming, in pixels per hour.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? MaxPixelsPerHour { get; set; }

    /// <summary>
    /// Enables in-canvas editing: allocations can be dragged to move them in time
    /// (and, unless <see cref="AllowResourceChange"/> is <c>false</c>, onto another
    /// resource row) or grabbed near an edge to resize their start/end. Commits
    /// are reported via the component's <c>OnAllocationChanged</c> callback.
    /// Defaults to <c>false</c> (read-only).
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Editable { get; set; }

    /// <summary>
    /// Snap increment (in minutes) applied to a move/resize while editing. Set to
    /// <c>0</c> for continuous (unsnapped) editing. Defaults to 15.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? EditSnapMinutes { get; set; }

    /// <summary>
    /// Grab zone (in pixels) at each end of a bar within which a drag resizes
    /// that edge rather than moving the whole bar. Defaults to 6.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? EditResizeHandlePx { get; set; }

    /// <summary>
    /// Minimum allocation duration (in minutes) a resize can produce, so a bar
    /// cannot be shrunk to nothing. Defaults to 5.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? EditMinDurationMinutes { get; set; }

    /// <summary>
    /// Whether a move drag may reassign an allocation to a different resource row.
    /// Defaults to <c>true</c>. Only has an effect while <see cref="Editable"/> is set.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? AllowResourceChange { get; set; }

    /// <summary>
    /// Whether hovering a bar (mouse/pen) shows a tooltip. The tooltip text is the
    /// allocation's <see cref="BlazorResourceTimelineAllocation.Tooltip"/> when set,
    /// otherwise a default built from its labels, resource name and time range.
    /// Defaults to <c>true</c>.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? ShowTooltips { get; set; }

    /// <summary>
    /// Delay (in milliseconds) after the pointer settles on a bar before its
    /// tooltip appears. Defaults to 300. Ignored when <see cref="ShowTooltips"/>
    /// is <c>false</c>.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? TooltipDelayMs { get; set; }

    /// <summary>
    /// On-demand loading: how many viewport-widths of extra time to fetch on each
    /// side of the visible range when requesting a window (see the component's
    /// <c>LoadAllocationsAsync</c> callback). Larger values fetch more per request
    /// but refetch less often. Defaults to 1.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? WindowBufferFactor { get; set; }

    /// <summary>
    /// On-demand loading: refetch once scrolling/zoom brings the visible range
    /// within this many viewport-widths of the loaded window's edge. Defaults to
    /// 0.25. Should be smaller than <see cref="WindowBufferFactor"/>.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? WindowRefetchThreshold { get; set; }

    /// <summary>
    /// On-demand loading: milliseconds to wait after the last scroll before
    /// checking whether a new window is needed, coalescing bursts. Defaults to 150.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? WindowDebounceMs { get; set; }

    /// <summary>Color overrides. Individual colors left <c>null</c> keep their defaults.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public BlazorResourceTimelineColors? Colors { get; set; }
}
