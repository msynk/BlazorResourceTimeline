using System.Text.Json.Serialization;

namespace BlazorResourceTimeline;

/// <summary>
/// What the left and right arrow keys do while the timeline has keyboard focus.
/// The up and down arrows always move between resource rows, and the editing
/// shortcuts (<c>Alt</c>+arrows) are unaffected by this choice.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum BlazorResourceTimelineArrowKeyNavigation
{
    /// <summary>
    /// Move the roving focus between the allocation bars of the focused row
    /// (the default). Use <c>PageUp</c>/<c>PageDown</c> to pan the time axis.
    /// </summary>
    Focus,

    /// <summary>
    /// Pan the time axis instead: one day per press, or one week with
    /// <c>Ctrl</c>/<c>Cmd</c> held. Bars can then only be focused with the
    /// up/down arrows and <c>Home</c>/<c>End</c>.
    /// </summary>
    Time
}
