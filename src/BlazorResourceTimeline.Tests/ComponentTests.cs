using Bunit;
using Microsoft.AspNetCore.Components;
using BlazorResourceTimeline.Models;
using TimelineComponent = BlazorResourceTimeline.Components.BlazorResourceTimeline;

namespace BlazorResourceTimeline.Tests;

/// <summary>
/// Component-lifecycle tests using bUnit with JS interop mocked (loose mode).
/// These exercise the Razor component's render/init/dispose paths and the
/// on-demand (windowed) load path without a real browser/canvas.
/// </summary>
public class ComponentTests : BunitContext
{
    private static BlazorResourceTimelineConfig SampleConfig() => new()
    {
        Resources = [new() { Id = "r1", Name = "Resource 1" }],
        StartDate = DateTimeOffset.FromUnixTimeMilliseconds(0),
        EndDate = DateTimeOffset.FromUnixTimeMilliseconds(3_600_000),
        Allocations =
        [
            new()
            {
                Id = "a1",
                ResourceId = "r1",
                StartTime = DateTimeOffset.FromUnixTimeMilliseconds(0),
                EndTime = DateTimeOffset.FromUnixTimeMilliseconds(60_000),
            },
        ],
    };

    [Fact]
    public void Renders_Container_And_Wrapper()
    {
        JSInterop.Mode = JSRuntimeMode.Loose;

        var cut = Render<TimelineComponent>(p => p.Add(c => c.Config, SampleConfig()));

        // The renderer's surface element (canvas/svg/div) is created by JS at
        // runtime, so only the container and the wrapper exist in the markup.
        Assert.NotNull(cut.Find(".timeline-container"));
        Assert.NotNull(cut.Find(".timeline-wrapper"));
    }

    [Fact]
    public void Sets_AriaLabel_And_Role_On_Focusable_Wrapper()
    {
        JSInterop.Mode = JSRuntimeMode.Loose;

        var cut = Render<TimelineComponent>(p => p
            .Add(c => c.Config, SampleConfig())
            .Add(c => c.AriaLabel, "Flight plan"));

        var wrapper = cut.Find(".timeline-wrapper");
        Assert.Equal("Flight plan", wrapper.GetAttribute("aria-label"));
        Assert.Equal("application", wrapper.GetAttribute("role"));
        Assert.Equal("0", wrapper.GetAttribute("tabindex"));
    }

    [Fact]
    public void Advertises_Editing_Shortcuts_Only_When_Editable()
    {
        JSInterop.Mode = JSRuntimeMode.Loose;

        var cut = Render<TimelineComponent>(p => p
            .Add(c => c.Config, SampleConfig())
            .Add(c => c.Options, new BlazorResourceTimelineOptions { Editable = true }));

        var shortcuts = cut.Find(".timeline-wrapper").GetAttribute("aria-keyshortcuts");
        Assert.Contains("Alt+ArrowLeft", shortcuts);
        Assert.Contains("Alt+Shift+ArrowUp", shortcuts);
    }

    [Fact]
    public void Windowed_Mode_Requests_Initial_Window_From_Host()
    {
        JSInterop.Mode = JSRuntimeMode.Loose;
        const long start = 0;
        const long end = 3_600_000;
        JSInterop.Setup<long[]>("getVisibleWindow").SetResult([start, end]);

        BlazorResourceTimelineWindow? captured = null;
        Task<IReadOnlyList<BlazorResourceTimelineAllocation>> Load(BlazorResourceTimelineWindow window)
        {
            captured = window;
            return Task.FromResult<IReadOnlyList<BlazorResourceTimelineAllocation>>(
                Array.Empty<BlazorResourceTimelineAllocation>());
        }

        var cut = Render<TimelineComponent>(p => p
            .Add(c => c.Config, SampleConfig())
            .Add(c => c.LoadAllocationsAsync, Load));

        cut.WaitForAssertion(() => Assert.NotNull(captured), TimeSpan.FromSeconds(5));
        Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(start), captured!.Start);
        Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(end), captured.End);
    }

    [Fact]
    public void Resource_Template_Renders_A_Row_Per_Reported_Row()
    {
        JSInterop.Mode = JSRuntimeMode.Loose;

        RenderFragment<BlazorResourceTimelineRowContext> template = ctx => builder =>
            builder.AddMarkupContent(0, $"<span class=\"tpl\">{ctx.Resource.Name}</span>");

        var cut = Render<TimelineComponent>(p => p
            .Add(c => c.Config, SampleConfig())
            .Add(c => c.ResourceTemplate, template));

        // Simulate the renderer reporting its visible rows.
        cut.InvokeAsync(() => cut.Instance.OnResourceRowsChanged(
        [
            new TimelineComponent.ResourceRow { Id = "grp", Name = "Group", HasChildren = true },
            new TimelineComponent.ResourceRow { Id = "r1", Name = "Resource 1", Depth = 1 },
        ]));

        var rows = cut.FindAll(".timeline-resource-row");
        Assert.Equal(2, rows.Count);
        Assert.Contains("Group", cut.Markup);
        Assert.Contains("Resource 1", cut.Markup);
        // The group row gets an expand/collapse chevron; the leaf does not.
        Assert.Single(cut.FindAll(".timeline-resource-chevron"));
    }

    [Fact]
    public void Disposes_Without_Throwing()
    {
        JSInterop.Mode = JSRuntimeMode.Loose;

        var cut = Render<TimelineComponent>(p => p.Add(c => c.Config, SampleConfig()));

        // Disposing the context tears down the component; the mocked JS side
        // should let DisposeAsync complete without throwing.
        var exception = Record.Exception(Dispose);
        Assert.Null(exception);
    }
}
