using Bunit;
using Microsoft.AspNetCore.Components;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.JSInterop;
using TimelineComponent = global::BlazorResourceTimeline.BlazorResourceTimeline;

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
    public async Task Resource_Template_Renders_A_Row_Per_Reported_Row()
    {
        JSInterop.Mode = JSRuntimeMode.Loose;

        RenderFragment<BlazorResourceTimelineRowContext> template = ctx => builder =>
            builder.AddMarkupContent(0, $"<span class=\"tpl\">{ctx.Resource.Name}</span>");

        var cut = Render<TimelineComponent>(p => p
            .Add(c => c.Config, SampleConfig())
            .Add(c => c.ResourceTemplate, template));

        // Simulate the renderer reporting its visible rows. Awaiting the
        // dispatcher matters: the callback re-renders through StateHasChanged,
        // so asserting on the markup before it completes is a race.
        await cut.InvokeAsync(() => cut.Instance.OnResourceRowsChanged(
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
    public async Task Resource_Axis_Resize_Updates_Overlay_Width_And_Raises_Callback()
    {
        JSInterop.Mode = JSRuntimeMode.Loose;

        var widths = new List<int>();
        RenderFragment<BlazorResourceTimelineRowContext> template = ctx => builder =>
            builder.AddMarkupContent(0, "<span class=\"tpl\">row</span>");

        var cut = Render<TimelineComponent>(p => p
            .Add(c => c.Config, SampleConfig())
            .Add(c => c.ResourceTemplate, template)
            .Add(c => c.TopStartContent, (RenderFragment)(b => b.AddMarkupContent(0, "<span>corner</span>")))
            .Add(c => c.OnResourceAxisWidthChanged, EventCallback.Factory.Create<int>(this, w => widths.Add(w))));

        await cut.InvokeAsync(() => cut.Instance.OnResourceAxisResized(220));

        Assert.Contains("220px", cut.Find(".timeline-resource-overlay").GetAttribute("style"));
        Assert.Contains("220px", cut.Find(".timeline-top-start").GetAttribute("style"));
        Assert.Equal(220, Assert.Single(widths));
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

    [Fact]
    public async Task Initialization_Interrupted_By_Disposal_Marshals_Nothing_And_Leaks_Nothing()
    {
        // The real runtime is used here (bUnit's mock cannot hold a module import
        // open) so the component is torn down between importing the engine and
        // creating the renderer against it.
        var runtime = new PausedImportJSRuntime();
        Services.AddSingleton<IJSRuntime>(runtime);

        var cut = Render<TimelineComponent>(p => p.Add(c => c.Config, SampleConfig()));
        await WaitUntil(() => runtime.Invocations.Contains("import"));

        await DisposeAsync(cut);
        runtime.CompleteImport();

        // The engine is created with a DotNetObjectReference to the component, so
        // resuming into createTimeline after disposal cannot work - the reference is
        // already gone. Initialization has to stop there, and release the module that
        // arrived too late for DisposeAsync to see.
        await WaitUntil(() => runtime.ModuleReleased || runtime.Invocations.Contains("createTimeline"));
        Assert.Null(runtime.MarshallingFailure);
        Assert.DoesNotContain("createTimeline", runtime.Invocations);
        Assert.True(runtime.ModuleReleased, "The module imported after disposal was leaked.");
    }

    [Fact]
    public async Task Load_In_Flight_Stops_When_Disposed()
    {
        JSInterop.Mode = JSRuntimeMode.Loose;
        // Hold the initial load inside JS so disposal lands in the middle of it.
        var setData = JSInterop.SetupVoid("setData", _ => true);

        var cut = Render<TimelineComponent>(p => p.Add(c => c.Config, SampleConfig()));
        await WaitUntil(() => setData.Invocations.Count > 0);

        await DisposeAsync(cut);
        setData.SetVoidResult();

        // Let the load's continuation resume: the rest of the load must be skipped
        // rather than pushed into a renderer that no longer exists (and releasing
        // the load gate afterwards must not throw either).
        await Task.Delay(100);
        Assert.Empty(JSInterop.Invocations["whenRendered"]);
    }

    [Fact]
    public async Task Dispose_Runs_The_Js_Teardown_Once()
    {
        JSInterop.Mode = JSRuntimeMode.Loose;

        var cut = Render<TimelineComponent>(p => p.Add(c => c.Config, SampleConfig()));
        await WaitUntil(() => JSInterop.Invocations["setData"].Count > 0);

        await DisposeAsync(cut);
        var exception = await Record.ExceptionAsync(() => DisposeAsync(cut));

        Assert.Null(exception);
        Assert.Single(JSInterop.Invocations["dispose"]);
    }

    // Tears the component down the way the framework does when the host stops
    // rendering it: IAsyncDisposable, on the renderer's dispatcher.
    private static Task DisposeAsync(IRenderedComponent<TimelineComponent> cut) =>
        cut.InvokeAsync(async () => await cut.Instance.DisposeAsync());

    // Continuations resume on the renderer's dispatcher, so state that a disposed
    // component settles into is only observable after yielding a few times.
    private static async Task WaitUntil(Func<bool> condition)
    {
        for (var i = 0; i < 200 && !condition(); i++)
        {
            await Task.Delay(10);
        }

        Assert.True(condition(), "The expected state was never reached.");
    }

    /// <summary>
    /// A JS runtime that keeps the engine's module import pending until the test
    /// releases it, and that marshals arguments the way the real runtime does: a
    /// <see cref="DotNetObjectReference{TValue}"/> belonging to a disposed component
    /// cannot be passed to JavaScript, which is recorded here rather than thrown so
    /// the test can assert on it.
    /// </summary>
    private sealed class PausedImportJSRuntime : IJSRuntime
    {
        private readonly TaskCompletionSource<IJSObjectReference> import =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        private readonly ModuleReference module;

        public PausedImportJSRuntime() => module = new ModuleReference(this);

        public List<string> Invocations { get; } = [];

        public Exception? MarshallingFailure { get; private set; }

        public bool ModuleReleased => module.Released;

        public void CompleteImport() => import.SetResult(module);

        public ValueTask<TValue> InvokeAsync<TValue>(string identifier, object?[]? args) =>
            InvokeAsync<TValue>(identifier, CancellationToken.None, args);

        public ValueTask<TValue> InvokeAsync<TValue>(
            string identifier, CancellationToken cancellationToken, object?[]? args)
        {
            Invocations.Add(identifier);
            Marshal(args);

            return identifier == "import"
                ? new ValueTask<TValue>(import.Task.ContinueWith(
                    imported => (TValue)imported.Result, TaskScheduler.Default))
                : ValueTask.FromResult<TValue>(default!);
        }

        private void Marshal(object?[]? args)
        {
            foreach (var arg in args ?? [])
            {
                if (arg is not DotNetObjectReference<TimelineComponent> callbackTarget)
                {
                    continue;
                }

                try
                {
                    _ = callbackTarget.Value;
                }
                catch (Exception exception)
                {
                    MarshallingFailure ??= exception;
                }
            }
        }

        private sealed class ModuleReference(PausedImportJSRuntime runtime) : IJSObjectReference
        {
            public bool Released { get; private set; }

            public ValueTask<TValue> InvokeAsync<TValue>(string identifier, object?[]? args) =>
                runtime.InvokeAsync<TValue>(identifier, CancellationToken.None, args);

            public ValueTask<TValue> InvokeAsync<TValue>(
                string identifier, CancellationToken cancellationToken, object?[]? args) =>
                runtime.InvokeAsync<TValue>(identifier, cancellationToken, args);

            public ValueTask DisposeAsync()
            {
                Released = true;
                return ValueTask.CompletedTask;
            }
        }
    }
}
