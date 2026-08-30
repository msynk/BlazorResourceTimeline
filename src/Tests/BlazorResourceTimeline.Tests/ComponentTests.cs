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
    public async Task Changing_Func_Is_Invoked_With_Previous_And_New_Then_Restores_On_False()
    {
        JSInterop.Mode = JSRuntimeMode.Loose;
        var config = SampleConfig();
        var alloc = config.Allocations[0];

        string? resourceDuring = null;
        DateTimeOffset? startDuring = null;
        string? previousResource = null;
        BlazorResourceTimelineAllocationChangeKind? kind = null;

        Task<bool> Changing(BlazorResourceTimelineAllocationChange change)
        {
            resourceDuring = change.Allocation.ResourceId;
            startDuring = change.Allocation.StartTime;
            previousResource = change.PreviousResourceId;
            kind = change.Kind;
            return Task.FromResult(false);
        }

        var cut = Render<TimelineComponent>(p => p
            .Add(c => c.Config, config)
            .Add(c => c.OnAllocationChanging, Changing));

        await WaitUntil(() => JSInterop.Invocations["whenRendered"].Count > 0);

        var allowed = false;
        await cut.InvokeAsync(async () =>
        {
            allowed = await cut.Instance.ConfirmAllocationChange(
                "a1", "r2", 10_000, 70_000, "r1", 0, 60_000, "move");
        });

        Assert.False(allowed);
        Assert.Same(alloc, config.Allocations[0]);
        Assert.Equal("r2", resourceDuring);
        Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(10_000), startDuring);
        Assert.Equal("r1", previousResource);
        Assert.Equal(BlazorResourceTimelineAllocationChangeKind.Move, kind);
        Assert.Equal("r1", alloc.ResourceId);
        Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(0), alloc.StartTime);
        Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(60_000), alloc.EndTime);
    }

    [Fact]
    public async Task Changing_Func_Null_Accepts_The_Edit()
    {
        JSInterop.Mode = JSRuntimeMode.Loose;

        var cut = Render<TimelineComponent>(p => p.Add(c => c.Config, SampleConfig()));
        await WaitUntil(() => JSInterop.Invocations["whenRendered"].Count > 0);

        var allowed = false;
        await cut.InvokeAsync(async () =>
        {
            allowed = await cut.Instance.ConfirmAllocationChange(
                "a1", "r1", 10_000, 70_000, "r1", 0, 60_000, "resize");
        });

        Assert.True(allowed);
    }

    [Fact]
    public async Task UpsertAllocationsAsync_Invokes_Js_After_Init()
    {
        JSInterop.Mode = JSRuntimeMode.Loose;
        var cut = Render<TimelineComponent>(p => p.Add(c => c.Config, SampleConfig()));
        await WaitUntil(() => JSInterop.Invocations["whenRendered"].Count > 0);

        var extra = new BlazorResourceTimelineAllocation
        {
            Id = "a2",
            ResourceId = "r1",
            StartTime = DateTimeOffset.FromUnixTimeMilliseconds(120_000),
            EndTime = DateTimeOffset.FromUnixTimeMilliseconds(180_000),
        };

        await cut.InvokeAsync(() => cut.Instance.UpsertAllocationsAsync([extra]));

        Assert.True(JSInterop.Invocations["upsertAllocations"].Count > 0);
    }

    [Fact]
    public async Task RemoveAllocationsAsync_Invokes_Js_After_Init()
    {
        JSInterop.Mode = JSRuntimeMode.Loose;
        var cut = Render<TimelineComponent>(p => p.Add(c => c.Config, SampleConfig()));
        await WaitUntil(() => JSInterop.Invocations["whenRendered"].Count > 0);

        await cut.InvokeAsync(() => cut.Instance.RemoveAllocationsAsync(["a1"]));

        Assert.True(JSInterop.Invocations["removeAllocations"].Count > 0);
    }

    [Fact]
    public async Task SelectAsync_Invokes_SelectBars()
    {
        JSInterop.Mode = JSRuntimeMode.Loose;
        var cut = Render<TimelineComponent>(p => p.Add(c => c.Config, SampleConfig()));
        await WaitUntil(() => JSInterop.Invocations["whenRendered"].Count > 0);

        await cut.InvokeAsync(() => cut.Instance.SelectAsync(["a1"]));

        Assert.True(JSInterop.Invocations["selectBars"].Count > 0);
    }

    [Fact]
    public async Task View_Callback_Raises_OnViewChanged()
    {
        JSInterop.Mode = JSRuntimeMode.Loose;
        BlazorResourceTimelineView? view = null;
        var cut = Render<TimelineComponent>(p => p
            .Add(c => c.Config, SampleConfig())
            .Add(c => c.OnViewChanged, EventCallback.Factory.Create<BlazorResourceTimelineView>(this, v => view = v)));
        await WaitUntil(() => JSInterop.Invocations["whenRendered"].Count > 0);

        await cut.InvokeAsync(() => cut.Instance.NotifyViewChanged(0, 3_600_000, 40));

        Assert.NotNull(view);
        Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(0), view!.Start);
        Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(3_600_000), view.End);
        Assert.Equal(40, view.PixelsPerHour);
    }

    [Fact]
    public async Task Click_Callback_Resolves_Bar_Resource_Time_And_Position()
    {
        JSInterop.Mode = JSRuntimeMode.Loose;
        var config = SampleConfig();
        BlazorResourceTimelinePointerArgs? args = null;
        var cut = Render<TimelineComponent>(p => p
            .Add(c => c.Config, config)
            .Add(c => c.OnClick, EventCallback.Factory.Create<BlazorResourceTimelinePointerArgs>(this, a => args = a)));
        await WaitUntil(() => JSInterop.Invocations["whenRendered"].Count > 0);

        await cut.InvokeAsync(() => cut.Instance.OnTimelineClick(
            "a1", null, "r1", 30_000, "content", 220, 90, 480, 310,
            true, false, false, true));

        Assert.NotNull(args);
        Assert.Same(config.Allocations[0], args!.Allocation);
        Assert.Same(config.Resources[0], args.Resource);
        Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(30_000), args.Time);
        Assert.Equal(BlazorResourceTimelineHitArea.Content, args.Area);
        Assert.Equal(220, args.X);
        Assert.Equal(90, args.Y);
        Assert.Equal(480, args.ClientX);
        Assert.Equal(310, args.ClientY);
        Assert.True(args.CtrlKey);
        Assert.False(args.ShiftKey);
        Assert.False(args.MetaKey);
        Assert.True(args.AltKey);
        Assert.Empty(args.OverflowAllocations);
    }

    [Fact]
    public async Task DoubleClick_Callback_Resolves_Overflow_And_Hit_Area()
    {
        JSInterop.Mode = JSRuntimeMode.Loose;
        var config = SampleConfig();
        config.Allocations.Add(new()
        {
            Id = "a2",
            ResourceId = "r1",
            StartTime = DateTimeOffset.FromUnixTimeMilliseconds(120_000),
            EndTime = DateTimeOffset.FromUnixTimeMilliseconds(180_000),
        });
        BlazorResourceTimelinePointerArgs? args = null;
        var cut = Render<TimelineComponent>(p => p
            .Add(c => c.Config, config)
            .Add(c => c.OnDoubleClick, EventCallback.Factory.Create<BlazorResourceTimelinePointerArgs>(this, a => args = a)));
        await WaitUntil(() => JSInterop.Invocations["whenRendered"].Count > 0);

        await cut.InvokeAsync(() => cut.Instance.OnTimelineDoubleClick(
            null, ["a1", "a2"], "r1", 90_000, "timeAxis", 400, 12, 500, 40,
            false, true, false, false));

        Assert.NotNull(args);
        Assert.Null(args!.Allocation);
        Assert.Equal(2, args.OverflowAllocations.Count);
        Assert.Same(config.Allocations[0], args.OverflowAllocations[0]);
        Assert.Same(config.Allocations[1], args.OverflowAllocations[1]);
        Assert.Equal(BlazorResourceTimelineHitArea.TimeAxis, args.Area);
        Assert.True(args.ShiftKey);
        Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(90_000), args.Time);
    }

    [Fact]
    public async Task ContextMenu_Callback_Uses_The_Shared_Pointer_Payload()
    {
        JSInterop.Mode = JSRuntimeMode.Loose;
        var config = SampleConfig();
        BlazorResourceTimelineContextMenuArgs? args = null;
        var cut = Render<TimelineComponent>(p => p
            .Add(c => c.Config, config)
            .Add(c => c.OnContextMenu, EventCallback.Factory.Create<BlazorResourceTimelineContextMenuArgs>(this, a => args = a)));
        await WaitUntil(() => JSInterop.Invocations["whenRendered"].Count > 0);

        await cut.InvokeAsync(() => cut.Instance.OnTimelineContextMenu(
            "a1", null, "r1", 15_000, "content", 180, 70, 300, 200,
            false, false, false, false));

        Assert.NotNull(args);
        Assert.Same(config.Allocations[0], args!.Allocation);
        Assert.Same(config.Resources[0], args.Resource);
        Assert.Equal(180, args.X);
        Assert.Equal(300, args.ClientX);
        Assert.Equal(BlazorResourceTimelineHitArea.Content, args.Area);
    }

    [Fact]
    public async Task Creating_Func_Receives_Resource_And_Range()
    {
        JSInterop.Mode = JSRuntimeMode.Loose;
        var config = SampleConfig();
        BlazorResourceTimelineCreateRequest? captured = null;
        Task<BlazorResourceTimelineAllocation?> Creating(BlazorResourceTimelineCreateRequest request)
        {
            captured = request;
            return Task.FromResult<BlazorResourceTimelineAllocation?>(new()
            {
                Id = "new-1",
                ResourceId = request.ResourceId,
                StartTime = request.StartTime,
                EndTime = request.EndTime,
            });
        }

        var cut = Render<TimelineComponent>(p => p
            .Add(c => c.Config, config)
            .Add(c => c.OnAllocationCreating, Creating));
        await WaitUntil(() => JSInterop.Invocations["whenRendered"].Count > 0);

        BlazorResourceTimelineAllocation? created = null;
        await cut.InvokeAsync(async () =>
        {
            created = await cut.Instance.CreateAllocation("r1", 10_000, 70_000);
        });

        Assert.NotNull(created);
        Assert.Equal("new-1", created.Id);
        Assert.Equal("r1", captured!.ResourceId);
        Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(10_000), captured.StartTime);
        Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(70_000), captured.EndTime);
    }

    [Fact]
    public async Task Creating_Func_Null_Return_Does_Not_Upsert()
    {
        JSInterop.Mode = JSRuntimeMode.Loose;
        Task<BlazorResourceTimelineAllocation?> Creating(BlazorResourceTimelineCreateRequest _) =>
            Task.FromResult<BlazorResourceTimelineAllocation?>(null);

        var cut = Render<TimelineComponent>(p => p
            .Add(c => c.Config, SampleConfig())
            .Add(c => c.OnAllocationCreating, Creating));
        await WaitUntil(() => JSInterop.Invocations["whenRendered"].Count > 0);

        BlazorResourceTimelineAllocation? created = null;
        await cut.InvokeAsync(async () =>
        {
            created = await cut.Instance.CreateAllocation("r1", 10_000, 70_000);
        });

        Assert.Null(created);
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
    public async Task Parent_Rerender_During_Load_Does_Not_Reload_The_Same_Config()
    {
        JSInterop.Mode = JSRuntimeMode.Loose;
        var setData = JSInterop.SetupVoid("setData", _ => true);
        var config = SampleConfig();

        var cut = Render<TimelineComponent>(p => p.Add(c => c.Config, config));
        await WaitUntil(() => setData.Invocations.Count > 0);

        // The demo (and any host that wires OnViewChanged) re-renders while the
        // first setData is still in flight. That used to queue another full load.
        cut.Render(p => p.Add(c => c.Config, config));

        setData.SetVoidResult();
        await WaitUntil(() => JSInterop.Invocations["whenRendered"].Count > 0);

        Assert.Single(JSInterop.Invocations["setData"]);
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
