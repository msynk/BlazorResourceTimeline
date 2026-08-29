using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;

namespace BlazorResourceTimeline;

/// <summary>
/// A resource timeline / planner: a horizontal time axis, resource rows down the
/// vertical axis, and allocation bars drawn in between. The markup lives in
/// <c>BlazorResourceTimeline.razor</c>; everything below is its behavior -
/// parameters, the JavaScript interop that drives the rendering engine, and the
/// callbacks the engine invokes back into .NET.
/// </summary>
public partial class BlazorResourceTimeline
{
    private const string ModulePath = "./_content/BlazorResourceTimeline/resource-timeline.js";

    // Default corner size; replaced with the renderer's actual layout after init.
    private BlazorResourceTimelineLayout _layout = new(150, 60, 40);

    private ElementReference _wrapperElement;
    private ElementReference _resourceOverlayInner;

    // Visible rows reported by the renderer, used to render the resource-column
    // template overlay. Kept in sync via OnResourceRowsChanged.
    private IReadOnlyList<ResourceRow> _resourceRows = Array.Empty<ResourceRow>();
    private Dictionary<string, BlazorResourceTimelineResource> _resourcesById = new();
    private IJSObjectReference? _jsModule;
    private IJSObjectReference? _timelineInstance;
    private DotNetObjectReference<BlazorResourceTimeline>? _selfRef;
    private bool _dataLoaded;
    private bool _isLoading;

    // Set as the very first statement of DisposeAsync. Every await in this file is
    // a point where the host can remove the component (a route change, a @key
    // remount, a parent that stops rendering it), so anything resuming after an
    // await must re-check this before touching JS interop, _selfRef or the render tree.
    private bool _disposed;

    // Serializes data loads so rapid Config swaps can't interleave two loads
    // and race _isLoading/_loadedConfig.
    private readonly SemaphoreSlim _loadGate = new(1, 1);

    // Reference of the config last pushed to JS. Used to skip redundant (and
    // expensive) re-marshalling when the parent re-renders without data changes.
    private BlazorResourceTimelineConfig? _loadedConfig;

    // Reference of the options last pushed to JS, compared the same way so
    // re-renders without an options change don't re-marshal them.
    private BlazorResourceTimelineOptions? _loadedOptions;

    // Lookup for resolving allocation ids reported by the renderer back to the
    // caller's own instances. Selection interop only exchanges ids: it keeps
    // payloads small (large marquee selections would otherwise exceed Blazor
    // Server's SignalR message size limit) and lets consumers compare selected
    // bars by reference against their own data.
    private Dictionary<string, BlazorResourceTimelineAllocation> _allocationsById = new();

    /// <summary>
    /// Data the timeline renders: the resource rows, the visible time window and
    /// the allocation bars. The timeline renders once this is set and re-renders
    /// whenever a new instance is assigned.
    /// </summary>
    [Parameter] public BlazorResourceTimelineConfig? Config { get; set; }

    /// <summary>
    /// Optional visual configuration (dimensions, fonts and colors). Any value
    /// left <c>null</c> keeps the renderer's default. Assign a new instance to
    /// re-apply (for example to switch themes at runtime).
    /// </summary>
    [Parameter] public BlazorResourceTimelineOptions? Options { get; set; }

    /// <summary>
    /// Accessible name for the timeline, exposed as the <c>aria-label</c> of the
    /// focusable region. Screen-reader users hear this when the component gains
    /// focus. Defaults to "Resource timeline".
    /// </summary>
    [Parameter] public string AriaLabel { get; set; } = "Resource timeline";

    /// <summary>
    /// Raised whenever the set of selected bars changes. The array contains every
    /// currently selected bar, in selection order, and is empty when nothing is selected.
    /// For a single click the array will contain exactly one element. Elements are
    /// the same instances supplied in <see cref="Config"/>, so they can be compared
    /// by reference against the caller's own data.
    /// Selection supports click, Ctrl/Cmd-click to toggle individual bars, and
    /// click-and-drag to rubber-band select a region.
    /// </summary>
    [Parameter] public EventCallback<BlazorResourceTimelineAllocation[]> OnSelectionChanged { get; set; }

    /// <summary>
    /// Raised after an allocation is moved or resized in the timeline (only when
    /// editing is enabled via <see cref="BlazorResourceTimelineOptions.Editable"/>).
    /// The argument is the same instance supplied in <see cref="Config"/>, already
    /// updated in place with its new <see cref="BlazorResourceTimelineAllocation.StartTime"/>,
    /// <see cref="BlazorResourceTimelineAllocation.EndTime"/> and
    /// <see cref="BlazorResourceTimelineAllocation.ResourceId"/>, so the handler
    /// only needs to persist the change. The renderer updates optimistically; to
    /// reject an edit, restore the instance and call <see cref="ReloadAsync"/>.
    /// </summary>
    [Parameter] public EventCallback<BlazorResourceTimelineAllocation> OnAllocationChanged { get; set; }

    /// <summary>
    /// Raised when the user right-clicks the timeline (the native browser menu
    /// is suppressed either way). The args identify what was under the pointer -
    /// the bar (if any), the resource row and the time - plus the viewport
    /// coordinates of the click, so the handler can render its own context menu
    /// at that position. Fires for bars, empty content slots and resource-axis
    /// rows; not for the time axis. Right-clicking does not change the selection.
    /// </summary>
    [Parameter] public EventCallback<BlazorResourceTimelineContextMenuArgs> OnContextMenu { get; set; }

    /// <summary>
    /// Raised after the user finishes resizing the resource column (pointer
    /// release, or a keyboard step on the divider). The argument is the new
    /// width in pixels, already clamped to
    /// <see cref="BlazorResourceTimelineOptions.ResourceAxisMinWidth"/> /
    /// <see cref="BlazorResourceTimelineOptions.ResourceAxisMaxWidth"/> and
    /// the viewport. Does not fire for every pointermove. Hosts that want to
    /// persist the width should store it and pass it back as
    /// <see cref="BlazorResourceTimelineOptions.ResourceAxisWidth"/>.
    /// </summary>
    [Parameter] public EventCallback<int> OnResourceAxisWidthChanged { get; set; }

    /// <summary>
    /// Optional custom content rendered in the top-start corner of the component
    /// (the otherwise blank cell where the time axis and resource axis meet).
    /// </summary>
    [Parameter] public RenderFragment? TopStartContent { get; set; }

    /// <summary>
    /// Optional template for each row in the sticky resource column. When set, the
    /// renderer stops drawing the resource labels and an HTML overlay renders this
    /// template per visible row instead, enabling rich, interactive content
    /// (badges, links, avatars, etc.). Group rows automatically get an
    /// expand/collapse chevron before the template. The overlay follows vertical
    /// scroll. The resource-column divider stays above the overlay so the column
    /// remains resizable. The context exposes the resource, its depth and its group state.
    /// </summary>
    [Parameter] public RenderFragment<BlazorResourceTimelineRowContext>? ResourceTemplate { get; set; }

    /// <summary>
    /// Optional custom content shown as an overlay while the renderer is
    /// drawing the bars. When not provided, a default spinner is displayed.
    /// </summary>
    [Parameter] public RenderFragment? LoadingContent { get; set; }

    /// <summary>
    /// Minimum time (in milliseconds) the loading overlay stays visible. Rendering
    /// often completes within a frame or two, which is too brief to perceive; set
    /// this to a small value (for example 300) to keep the overlay on screen long
    /// enough to be seen. Defaults to 0 (no artificial delay).
    /// </summary>
    [Parameter] public int LoadingMinDurationMs { get; set; }

    /// <summary>
    /// Maximum number of allocations sent per interop call. Datasets larger
    /// than this are streamed to the renderer in batches of this size instead
    /// of one large call, which keeps individual interop messages bounded (so a
    /// single multi-megabyte payload doesn't block the SignalR circuit on
    /// Blazor Server) and lets the circuit breathe between batches. Set to 0 (or
    /// a negative value) to always send everything in a single call.
    /// </summary>
    [Parameter] public int LoadBatchSize { get; set; } = 10000;

    /// <summary>
    /// Enables on-demand (windowed) data loading. When set, the timeline does not
    /// take its bars from <see cref="BlazorResourceTimelineConfig.Allocations"/>;
    /// instead it calls this delegate with the time window currently needed (the
    /// visible range plus a buffer) and expects every allocation overlapping that
    /// window, across all resources. It is called again as the user scrolls or
    /// zooms near the edge of the loaded window. This keeps memory and interop
    /// bounded for effectively unbounded datasets. <see cref="Config"/> still
    /// supplies the resources and overall <c>StartDate</c>/<c>EndDate</c>.
    /// Leave <c>null</c> to load all allocations up front (the default).
    /// </summary>
    [Parameter]
    public Func<BlazorResourceTimelineWindow, Task<IReadOnlyList<BlazorResourceTimelineAllocation>>>? LoadAllocationsAsync { get; set; }

    private bool HasData => Config is not null;

    private bool IsWindowed => LoadAllocationsAsync is not null;

    // Serializes host window fetches and tracks the newest request id so a slow
    // fetch that has been superseded is discarded instead of pushed to the JS.
    private readonly SemaphoreSlim _windowGate = new(1, 1);
    private long _latestWindowRequestId;

    // Base navigation/selection shortcuts, plus the editing shortcuts when
    // that mode is on, advertised via aria-keyshortcuts.
    private const string BaseKeyShortcuts =
        "ArrowLeft ArrowRight ArrowUp ArrowDown Home End PageUp PageDown Enter Escape";
    private const string EditingKeyShortcuts =
        " Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown Alt+Shift+ArrowLeft Alt+Shift+ArrowRight Alt+Shift+ArrowUp Alt+Shift+ArrowDown";

    private string KeyShortcuts =>
        BaseKeyShortcuts
        + (Options?.Editable == true ? EditingKeyShortcuts : "");

    /// <summary>
    /// On the first render, imports the JavaScript engine, creates the renderer
    /// against the wrapper element, reads the effective layout back and loads the
    /// initial data. Later renders do nothing here.
    /// </summary>
    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (!firstRender || _disposed)
        {
            return;
        }

        try
        {
            await InitializeAsync();
        }
        catch (JSDisconnectedException)
        {
            // The circuit is gone; there is no JS side left to initialize.
        }
        catch (Exception exception) when (_disposed && IsTeardownFailure(exception))
        {
            // Removed part-way through initialization: DisposeAsync ran before the JS
            // objects existed, so release whatever arrived after it looked for them.
            await ReleaseJsResourcesAsync();
        }
    }

    // Brings up the JS side of the component. Each await here can resume after the
    // host has already removed the component, which is why every one of them is
    // followed by a disposal check: the very next interop call would otherwise
    // marshal an already-disposed handle (notably _selfRef, passed to createTimeline).
    private async Task InitializeAsync()
    {
        _selfRef = DotNetObjectReference.Create(this);

        _jsModule = await JS.InvokeAsync<IJSObjectReference>("import", ModulePath);
        ThrowIfDisposed();

        _timelineInstance = await _jsModule.InvokeAsync<IJSObjectReference>(
            "createTimeline", _wrapperElement, _selfRef, Options);
        ThrowIfDisposed();

        _loadedOptions = Options;

        // Read the effective layout back so the top-start corner overlay is
        // sized correctly (and the C# defaults never drift from the JS ones).
        _layout = await _timelineInstance.InvokeAsync<BlazorResourceTimelineLayout>("getLayout");
        ThrowIfDisposed();
        StateHasChanged();

        // Enable the HTML resource-column overlay before loading data, so the
        // renderer suppresses its own labels and the engine reports its rows.
        if (ResourceTemplate is not null)
        {
            await _timelineInstance.InvokeVoidAsync("enableResourceTemplate", _resourceOverlayInner);
            ThrowIfDisposed();
        }

        if (HasData)
        {
            await LoadDataAsync();
        }
    }

    private void ThrowIfDisposed() => ObjectDisposedException.ThrowIf(_disposed, this);

    // How interop fails when it is in flight while the component is being removed
    // or the circuit is dropping: the JS handle or the .NET object reference it
    // marshals has been disposed, the circuit is gone, or the call was cancelled.
    // None of these are actionable - they all mean this instance no longer has a
    // JS side to talk to - so they are only swallowed on the teardown paths below.
    private static bool IsTeardownFailure(Exception exception) =>
        exception is JSDisconnectedException or ObjectDisposedException or OperationCanceledException;

    /// <summary>
    /// Re-applies <see cref="Options"/> and reloads <see cref="Config"/> when
    /// either has been assigned a new instance. Both are compared by reference,
    /// so mutating one in place does not trigger an update.
    /// </summary>
    protected override async Task OnParametersSetAsync()
    {
        if (_disposed || _timelineInstance is null)
        {
            return;
        }

        if (OptionsChanged())
        {
            _loadedOptions = Options;
            await _timelineInstance.InvokeVoidAsync("setOptions", Options);
            _layout = await _timelineInstance.InvokeAsync<BlazorResourceTimelineLayout>("getLayout");

            if (_disposed)
            {
                return;
            }

            StateHasChanged();
        }

        if (HasData && DataChanged())
        {
            await LoadDataAsync();
        }
    }

    // Only the reference is compared. Mutating the config (or its lists) in place
    // without creating a new instance will not trigger a reload; assign a new
    // Config (or call ReloadAsync) when the contents change.
    private bool DataChanged() => !ReferenceEquals(_loadedConfig, Config);

    // As with Config, only the reference is compared: assign a new Options
    // instance to re-apply. Mutating the existing instance in place will not
    // trigger a re-apply.
    private bool OptionsChanged() => !ReferenceEquals(_loadedOptions, Options);

    private async Task LoadDataAsync()
    {
        // Capture the targets now; another load may be requested while we wait on
        // the gate, in which case this (older) one is skipped below.
        var timeline = _timelineInstance;
        var config = Config;
        if (_disposed || timeline is null || config is null)
        {
            return;
        }

        // Serialize loads so a rapid Config swap can't interleave two runs.
        await _loadGate.WaitAsync();
        try
        {
            // A newer Config superseded this one while we were queued (or the
            // component went away): that load will run, so drop this stale one.
            if (_disposed || !ReferenceEquals(Config, config))
            {
                return;
            }

            await LoadDataCoreAsync(timeline, config);
        }
        finally
        {
            _loadGate.Release();
        }
    }

    private async Task LoadDataCoreAsync(IJSObjectReference timeline, BlazorResourceTimelineConfig config)
    {
        _isLoading = true;
        StateHasChanged();
        // A short delay reliably lets the overlay paint before the synchronous
        // JS rendering work begins. Task.Yield alone flushes the render batch
        // but doesn't guarantee a browser paint on WebAssembly.
        await Task.Delay(1);

        if (_disposed)
        {
            return;
        }

        var startedAt = DateTime.UtcNow;
        try
        {
            var allocations = config.Allocations;
            var start = config.StartDate.ToUnixTimeMilliseconds();
            var end = config.EndDate.ToUnixTimeMilliseconds();

            if (IsWindowed)
            {
                // Set the rows and overall range, then fetch just the initial
                // visible window; further windows arrive via RequestAllocationWindow.
                await timeline.InvokeVoidAsync("beginWindowed", config.Resources, start, end);
                var window = await timeline.InvokeAsync<long[]>("getVisibleWindow");
                _latestWindowRequestId = 0;
                await FetchAndApplyWindowAsync(timeline, 0, window[0], window[1]);

                if (_disposed)
                {
                    return;
                }

                await timeline.InvokeVoidAsync("whenRendered");
                _loadedConfig = config;
                _dataLoaded = true;
                return;
            }

            if (LoadBatchSize > 0 && allocations.Count > LoadBatchSize)
            {
                // Stream large datasets in bounded batches so a single
                // multi-megabyte interop message doesn't block the circuit or
                // stall the main thread serializing/parsing it all at once.
                await timeline.InvokeVoidAsync(
                    "beginData", config.Resources, start, end, allocations.Count);

                for (var i = 0; i < allocations.Count; i += LoadBatchSize)
                {
                    // Streaming a large dataset spans many awaits; stop as soon as
                    // there is nothing left to stream into.
                    if (_disposed)
                    {
                        return;
                    }

                    var count = Math.Min(LoadBatchSize, allocations.Count - i);
                    var batch = allocations.GetRange(i, count);
                    await timeline.InvokeVoidAsync("appendAllocations", batch);
                }

                await timeline.InvokeVoidAsync("endData");
            }
            else
            {
                await timeline.InvokeVoidAsync(
                    "setData", config.Resources, start, end, allocations);
            }

            if (_disposed)
            {
                return;
            }

            // Wait until the renderer has painted the bars before hiding the overlay.
            await timeline.InvokeVoidAsync("whenRendered");

            var byId = new Dictionary<string, BlazorResourceTimelineAllocation>(allocations.Count);
            foreach (var allocation in allocations)
            {
                byId[allocation.Id] = allocation;
            }
            _allocationsById = byId;

            _loadedConfig = config;
            _dataLoaded = true;
        }
        finally
        {
            // Keep the overlay visible for a minimum duration so it doesn't
            // flash by imperceptibly on fast renders.
            var elapsed = (DateTime.UtcNow - startedAt).TotalMilliseconds;
            var remaining = LoadingMinDurationMs - (int)elapsed;
            if (remaining > 0 && !_disposed)
            {
                await Task.Delay(remaining);
            }

            _isLoading = false;
            if (!_disposed)
            {
                StateHasChanged();
            }
        }
    }

    /// <summary>Forces the current data to be re-sent to the renderer, even if the
    /// Config reference is unchanged. Use after mutating the config in place.</summary>
    public Task ReloadAsync()
    {
        _loadedConfig = null;
        return LoadDataAsync();
    }

    /// <summary>Clears the current bar selection programmatically.</summary>
    public async Task ClearSelectionAsync()
    {
        if (!_disposed && _timelineInstance is not null && _dataLoaded)
        {
            await _timelineInstance.InvokeVoidAsync("clearSelection");
        }
    }

    /// <summary>Returns the currently selected bars, in selection order. Empty when nothing is selected.</summary>
    public async Task<IReadOnlyList<BlazorResourceTimelineAllocation>> GetSelectedBarsAsync()
    {
        if (_disposed || _timelineInstance is null || !_dataLoaded)
        {
            return Array.Empty<BlazorResourceTimelineAllocation>();
        }

        var ids = await _timelineInstance.InvokeAsync<string[]>("getSelectedBarIds");
        return ResolveAllocations(ids);
    }

    /// <summary>
    /// Scrolls the timeline so the current time is centered in view.
    /// Returns <c>true</c> if "now" falls within the timeline's range and
    /// navigation occurred; otherwise <c>false</c>.
    /// </summary>
    public async Task<bool> GoToTodayAsync()
    {
        if (_disposed || _timelineInstance is null || !_dataLoaded)
        {
            return false;
        }

        return await _timelineInstance.InvokeAsync<bool>("goToNow");
    }

    /// <summary>
    /// Scrolls the timeline so the given time (Unix time in milliseconds) is
    /// centered in view. Returns <c>true</c> if the time is within range.
    /// </summary>
    public async Task<bool> ScrollToTimeAsync(long unixMs)
    {
        if (_disposed || _timelineInstance is null || !_dataLoaded)
        {
            return false;
        }

        return await _timelineInstance.InvokeAsync<bool>("scrollToTime", unixMs);
    }

    /// <summary>
    /// Pans the view by whole days without changing the zoom - positive moves
    /// forward in time, negative back. By default a step is exactly 24 hours,
    /// keeping the same time of day at the leading edge. With
    /// <see cref="BlazorResourceTimelineOptions.PanToDayStart"/> the leading
    /// edge lands on a local midnight instead (the start of the day
    /// <paramref name="days"/> calendar days away). Pass 7 or -7 for a week.
    /// A non-null <paramref name="panToDayStart"/> wins over that option for
    /// this call only. The pan is clamped to the timeline's range, so this
    /// returns <c>false</c> when the view is already against that end (or the
    /// whole range fits on screen). Hosts that want keyboard day/week steps
    /// should call this from their own key handler.
    /// </summary>
    public async Task<bool> PanByDaysAsync(int days, bool? panToDayStart = null)
    {
        if (_disposed || _timelineInstance is null || !_dataLoaded)
        {
            return false;
        }

        return await _timelineInstance.InvokeAsync<bool>("panByDays", days, panToDayStart);
    }

    /// <summary>
    /// Zooms in around the viewport center. Returns the new scale in pixels per
    /// hour (0 if the timeline is not ready).
    /// </summary>
    public async Task<double> ZoomInAsync()
    {
        if (_disposed || _timelineInstance is null)
        {
            return 0;
        }

        return await _timelineInstance.InvokeAsync<double>("zoomIn");
    }

    /// <summary>Zooms out around the viewport center. Returns the new scale in pixels per hour.</summary>
    public async Task<double> ZoomOutAsync()
    {
        if (_disposed || _timelineInstance is null)
        {
            return 0;
        }

        return await _timelineInstance.InvokeAsync<double>("zoomOut");
    }

    /// <summary>
    /// Zooms so exactly <paramref name="days"/> days fill the current viewport
    /// (the content area to the right of the resource axis), keeping the time
    /// under the viewport center fixed. The resulting scale is clamped to
    /// <see cref="BlazorResourceTimelineOptions.MinPixelsPerHour"/> /
    /// <see cref="BlazorResourceTimelineOptions.MaxPixelsPerHour"/>. Returns
    /// the new scale in pixels per hour (0 if the timeline is not ready, or
    /// the current scale if <paramref name="days"/> is not a finite positive
    /// number).
    /// </summary>
    public async Task<double> ZoomToDaysAsync(double days)
    {
        if (_disposed || _timelineInstance is null)
        {
            return 0;
        }

        return await _timelineInstance.InvokeAsync<double>("zoomToDays", days);
    }

    /// <summary>
    /// Sets an explicit horizontal scale in pixels per hour (clamped to the
    /// configured bounds), or pass <c>null</c> to return to auto/config scale.
    /// Returns the new effective scale.
    /// </summary>
    public async Task<double> SetPixelsPerHourAsync(double? pixelsPerHour)
    {
        if (_disposed || _timelineInstance is null)
        {
            return 0;
        }

        return await _timelineInstance.InvokeAsync<double>("setPixelsPerHour", pixelsPerHour);
    }

    /// <summary>Returns to the auto/config scale. Returns the new effective scale.</summary>
    public async Task<double> ResetZoomAsync()
    {
        if (_disposed || _timelineInstance is null)
        {
            return 0;
        }

        return await _timelineInstance.InvokeAsync<double>("resetZoom");
    }

    /// <summary>Returns the current horizontal scale in pixels per hour.</summary>
    public async Task<double> GetPixelsPerHourAsync()
    {
        if (_disposed || _timelineInstance is null)
        {
            return 0;
        }

        return await _timelineInstance.InvokeAsync<double>("getPixelsPerHour");
    }

    /// <summary>
    /// Invoked by the renderer (windowed mode) when scrolling/zooming needs a
    /// wider window than is currently loaded. Public only because JS interop
    /// requires it; not part of the consumer API.
    /// </summary>
    /// <param name="requestId">
    /// Monotonically increasing request id. A fetch is discarded if a newer
    /// request arrives while it runs.
    /// </param>
    /// <param name="startMs">Start of the needed window, as Unix time in milliseconds.</param>
    /// <param name="endMs">End of the needed window, as Unix time in milliseconds.</param>
    [JSInvokable]
    public async Task RequestAllocationWindow(long requestId, long startMs, long endMs)
    {
        if (_disposed || _timelineInstance is null || LoadAllocationsAsync is null)
        {
            return;
        }

        _latestWindowRequestId = Math.Max(_latestWindowRequestId, requestId);
        await FetchAndApplyWindowAsync(_timelineInstance, requestId, startMs, endMs);
    }

    // Fetches the allocations for a window from the host and pushes them to the
    // renderer, unless a newer request has superseded this one in the meantime.
    private async Task FetchAndApplyWindowAsync(
        IJSObjectReference timeline, long requestId, long startMs, long endMs)
    {
        if (LoadAllocationsAsync is null)
        {
            return;
        }

        await _windowGate.WaitAsync();
        try
        {
            // Superseded while queued behind the gate (or nothing left to render
            // into): skip the now-stale fetch.
            if (_disposed || requestId < _latestWindowRequestId)
            {
                return;
            }

            var window = new BlazorResourceTimelineWindow
            {
                Start = DateTimeOffset.FromUnixTimeMilliseconds(startMs),
                End = DateTimeOffset.FromUnixTimeMilliseconds(endMs),
            };

            var allocations = await LoadAllocationsAsync(window) ?? Array.Empty<BlazorResourceTimelineAllocation>();

            // A newer request arrived while the host was working, or the component
            // was removed; either way, drop this result.
            if (_disposed || requestId < _latestWindowRequestId)
            {
                return;
            }

            var byId = new Dictionary<string, BlazorResourceTimelineAllocation>(allocations.Count);
            foreach (var allocation in allocations)
            {
                byId[allocation.Id] = allocation;
            }
            _allocationsById = byId;

            await timeline.InvokeVoidAsync(
                "applyAllocationWindow", requestId, allocations, startMs, endMs);
        }
        finally
        {
            _windowGate.Release();
        }
    }

    /// <summary>
    /// Invoked by the renderer whenever the set/order of visible rows changes
    /// (data load or a group collapse/expand), so the resource-column template
    /// overlay can re-render. Rows are bounded, so this stays cheap. Public only
    /// because JS interop requires it; not part of the consumer API.
    /// </summary>
    /// <param name="rows">The rows currently visible, in display order.</param>
    [JSInvokable]
    public void OnResourceRowsChanged(ResourceRow[] rows)
    {
        if (_disposed)
        {
            return;
        }

        _resourceRows = rows;
        if (Config is not null)
        {
            _resourcesById = new Dictionary<string, BlazorResourceTimelineResource>(Config.Resources.Count);
            foreach (var resource in Config.Resources)
            {
                _resourcesById[resource.Id] = resource;
            }
        }
        StateHasChanged();
    }

    // Collapses/expands a group from the overlay's chevron.
    private async Task ToggleGroupAsync(string id)
    {
        if (!_disposed && _timelineInstance is not null)
        {
            await _timelineInstance.InvokeVoidAsync("toggleGroup", id);
        }
    }

    // Builds the template context for a row, resolving its full resource instance.
    private BlazorResourceTimelineRowContext ContextFor(ResourceRow row)
    {
        _resourcesById.TryGetValue(row.Id, out var resource);
        return new BlazorResourceTimelineRowContext
        {
            Resource = resource ?? new BlazorResourceTimelineResource { Id = row.Id, Name = row.Name },
            Depth = row.Depth,
            HasChildren = row.HasChildren,
            Collapsed = row.Collapsed,
        };
    }

    /// <summary>
    /// Row descriptor marshaled from the renderer (camelCase over interop),
    /// describing one currently visible row of the resource column.
    /// </summary>
    public sealed class ResourceRow
    {
        /// <summary>Id of the resource this row renders.</summary>
        public string Id { get; set; } = "";

        /// <summary>Display name of the resource.</summary>
        public string Name { get; set; } = "";

        /// <summary>Depth in the resource hierarchy; 0 for a top-level row.</summary>
        public int Depth { get; set; }

        /// <summary>Whether this row is a group (has child resources).</summary>
        public bool HasChildren { get; set; }

        /// <summary>Whether this group row is currently collapsed.</summary>
        public bool Collapsed { get; set; }


        /// <summary>Pixel height of this row (grows when overlapping bars stack).</summary>
        public int Height { get; set; }
    }

    /// <summary>
    /// Invoked by the renderer when the selection changes, raising
    /// <see cref="OnSelectionChanged"/> with the caller's own instances. Public
    /// only because JS interop requires it; not part of the consumer API.
    /// </summary>
    /// <param name="selectedIds">Ids of the selected allocations, in selection order.</param>
    [JSInvokable]
    public async Task OnSelectionUpdated(string[] selectedIds)
    {
        if (!_disposed && OnSelectionChanged.HasDelegate)
        {
            await OnSelectionChanged.InvokeAsync(ResolveAllocations(selectedIds));
        }
    }

    /// <summary>
    /// Invoked by the renderer when a bar is moved/resized. The times/resource are
    /// applied to the caller's own instance (resolved by id) so the change is
    /// reflected in <see cref="Config"/> without a reload, then
    /// <see cref="OnAllocationChanged"/> fires. Public only because JS interop
    /// requires it; not part of the consumer API.
    /// </summary>
    /// <param name="id">Id of the edited allocation.</param>
    /// <param name="resourceId">Resource the allocation now belongs to.</param>
    /// <param name="startTime">New start, as Unix time in milliseconds.</param>
    /// <param name="endTime">New end, as Unix time in milliseconds.</param>
    [JSInvokable]
    public async Task OnAllocationEdited(string id, string resourceId, long startTime, long endTime)
    {
        if (_disposed)
        {
            return;
        }

        if (!_allocationsById.TryGetValue(id, out var allocation))
        {
            return;
        }

        allocation.ResourceId = resourceId;
        allocation.StartTime = DateTimeOffset.FromUnixTimeMilliseconds(startTime);
        allocation.EndTime = DateTimeOffset.FromUnixTimeMilliseconds(endTime);

        if (OnAllocationChanged.HasDelegate)
        {
            await OnAllocationChanged.InvokeAsync(allocation);
        }
    }

    /// <summary>
    /// Invoked by the renderer on right-click. Ids are resolved back to the
    /// caller's own instances (as with selection) before
    /// <see cref="OnContextMenu"/> fires. Public only because JS interop
    /// requires it; not part of the consumer API.
    /// </summary>
    /// <param name="allocationId">Id of the bar under the pointer, or <c>null</c> if the click missed every bar.</param>
    /// <param name="resourceId">Id of the row under the pointer, or <c>null</c> below the last row.</param>
    /// <param name="time">Time at the pointer, as Unix time in milliseconds; <c>null</c> on the resource axis.</param>
    /// <param name="clientX">Viewport x coordinate of the click.</param>
    /// <param name="clientY">Viewport y coordinate of the click.</param>
    [JSInvokable]
    public async Task OnTimelineContextMenu(
        string? allocationId, string? resourceId, long? time, double clientX, double clientY)
    {
        if (_disposed || !OnContextMenu.HasDelegate)
        {
            return;
        }

        BlazorResourceTimelineAllocation? allocation = null;
        if (allocationId is not null)
        {
            _allocationsById.TryGetValue(allocationId, out allocation);
        }

        var resource = resourceId is null
            ? null
            : Config?.Resources.FirstOrDefault(r => r.Id == resourceId);

        await OnContextMenu.InvokeAsync(new BlazorResourceTimelineContextMenuArgs
        {
            Allocation = allocation,
            Resource = resource,
            Time = time is { } t ? DateTimeOffset.FromUnixTimeMilliseconds(t) : null,
            ClientX = clientX,
            ClientY = clientY,
        });
    }

    /// <summary>
    /// Invoked by the renderer after a resource-column resize commits. Updates
    /// the layout used to size the overlay and top-start corner, then raises
    /// <see cref="OnResourceAxisWidthChanged"/>. Public only because JS interop
    /// requires it; not part of the consumer API.
    /// </summary>
    /// <param name="width">New resource-column width, in pixels.</param>
    [JSInvokable]
    public async Task OnResourceAxisResized(int width)
    {
        if (_disposed)
        {
            return;
        }

        if (_layout.ResourceAxisWidth != width)
        {
            _layout = _layout with { ResourceAxisWidth = width };
            StateHasChanged();
        }

        if (OnResourceAxisWidthChanged.HasDelegate)
        {
            await OnResourceAxisWidthChanged.InvokeAsync(width);
        }
    }

    // Maps allocation ids reported by the renderer to the instances supplied
    // in the loaded Config, preserving order. Unknown ids (e.g. from a config
    // swapped mid-callback) are skipped.
    private BlazorResourceTimelineAllocation[] ResolveAllocations(string[] ids)
    {
        var result = new List<BlazorResourceTimelineAllocation>(ids.Length);
        foreach (var id in ids)
        {
            if (_allocationsById.TryGetValue(id, out var allocation))
            {
                result.Add(allocation);
            }
        }

        return result.ToArray();
    }

    /// <summary>
    /// Disposes the JavaScript renderer and module and the .NET object reference the
    /// engine calls back through. A disconnected circuit is treated as already
    /// cleaned up. Safe to call while initialization or a data load is still in
    /// flight: those stop at their next await rather than failing on the handles
    /// disposed here.
    /// </summary>
    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }

        // Set before the first await so in-flight interop sees it the moment it resumes.
        _disposed = true;

        try
        {
            await ReleaseJsResourcesAsync();
        }
        finally
        {
            // The load gates are deliberately left undisposed: a load may still be
            // queued on one, and disposing a SemaphoreSlim throws
            // ObjectDisposedException into everyone waiting on it. Nothing leaks -
            // SemaphoreSlim only holds a disposable resource once its
            // AvailableWaitHandle is used, which this component never does.

            // No finalizer here, but a derived component that introduces one
            // should not have to re-implement disposal to suppress it (CA1816).
            GC.SuppressFinalize(this);
        }
    }

    // Tears down the JS side of the component: the renderer instance, the module and
    // the .NET object reference the engine calls back through. Idempotent, and safe
    // to call from either DisposeAsync or an initialization that finished after it,
    // since the fields are cleared before the first await.
    private async ValueTask ReleaseJsResourcesAsync()
    {
        var timeline = _timelineInstance;
        var module = _jsModule;
        var selfRef = _selfRef;

        _timelineInstance = null;
        _jsModule = null;
        _selfRef = null;
        _dataLoaded = false;

        try
        {
            if (timeline is not null)
            {
                await timeline.InvokeVoidAsync("dispose");
                await timeline.DisposeAsync();
            }

            if (module is not null)
            {
                await module.DisposeAsync();
            }
        }
        catch (Exception exception) when (IsTeardownFailure(exception))
        {
            // The circuit or the handle is already gone; nothing to clean up on the JS side.
        }
        finally
        {
            selfRef?.Dispose();
        }
    }
}
