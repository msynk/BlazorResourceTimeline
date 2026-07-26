# BlazorResourceTimeline

[![NuGet](https://img.shields.io/nuget/v/BlazorResourceTimeline.svg)](https://www.nuget.org/packages/BlazorResourceTimeline)
[![Downloads](https://img.shields.io/nuget/dt/BlazorResourceTimeline.svg)](https://www.nuget.org/packages/BlazorResourceTimeline)
[![CI](https://github.com/msynk/BlazorResourceTimeline/actions/workflows/ci.yml/badge.svg)](https://github.com/msynk/BlazorResourceTimeline/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/msynk/BlazorResourceTimeline/blob/main/LICENSE)

A high-performance **resource-timeline / planner** component for ASP.NET Core Blazor,
with pluggable canvas, SVG and HTML renderers (canvas by default).

It renders a wide time window along the horizontal axis and a list of resources
along the vertical axis, drawing allocation bars in the grid between them. It is
built for dense, glanceable planning boards - flight/gate planning, train
scheduling, fleet and crew rostering, and similar transport use-cases - where a
lot of data must stay readable and interactive.

![BlazorResourceTimeline](https://raw.githubusercontent.com/msynk/BlazorResourceTimeline/main/docs/screenshot.png)

<sub>The demo in its dark theme: 68 resources and ~3,300 allocations on the canvas renderer.</sub>

## Features

- **Pluggable renderers**: one engine (data, layout, interaction) driving your
  choice of renderer via `Options.Renderer` - **Canvas** (default; HiDPI/Retina
  crispness via `ResizeObserver` + `device-pixel-content-box`, fastest for dense
  data), **SVG** (resolution-independent, inspectable, print friendly) or
  **HTML** (each bar is a real, CSS-styleable element). Per-frame culling keeps
  all three bounded by what is visible, and the renderer can be switched at
  runtime.
- **Zoom** from a multi-day overview down to hour-level detail
  (`Ctrl`/`Cmd` + mouse wheel, trackpad pinch, or the programmatic API), with
  adaptive tick/label density.
- **Selection**: click, `Ctrl`/`Cmd`-click to toggle, and click-and-drag
  marquee selection.
- **Editing** (opt-in): drag a bar to move it in time (or onto another
  resource), or grab an edge to resize it, with configurable snapping and a
  change callback back to .NET.
- **Context menu (right-click)**: the native browser menu is suppressed and a
  callback reports what was hit - the bar, the resource row, the time under the
  pointer and the click's viewport coordinates - so you can render your own menu.
- **Overlap stacking**: allocations that overlap in time on the same row are
  automatically stacked into lanes instead of drawn on top of each other, and
  the row grows to keep the whole stack inside it. `Options.ResourceHeight` is
  the *minimum* row height; `Options.BarMargin` sets the gap between lanes.
- **Hover tooltips**: per-bar tooltips (custom text or an auto-generated
  default), on by default and configurable.
- **Resource hierarchy**: nest resources into multi-level, collapsible groups
  via `ParentId`; click a group row (or use it from data) to expand/collapse.
- **On-demand (windowed) loading**: for effectively unbounded datasets, serve
  only the visible time window (plus a buffer) via a callback; the renderer
  refetches as the user scrolls/zooms.
- **Resource-column template**: replace the renderer-drawn resource labels with a
  rich, interactive HTML template per row (badges, links, avatars, …).
- **Keyboard & screen-reader accessible**: focusable region with `role`/
  `aria-label`, arrow-key bar navigation, keyboard selection, and live-region
  announcements.
- **Time-zone-aware axes** (IANA ids via `Intl`), correct across DST, with an
  optional `Locale` for day labels, tooltips and announcements.
- **Touch & pen** support via Pointer Events.
- **Streaming data load** for very large datasets (batched interop instead of
  one giant payload).
- **Theming**: every painted color is overridable through `Options.Colors`, so
  a light, dark or brand palette is just another `Options` instance - switchable
  at runtime (the demo ships a dark theme).
- **Rich bars**: per-bar colors and heights, labels (above/below/start/end),
  image/SVG icons anchored to any side, and start/end "edge" (delay) bars.
- **Dimensions & fonts**: axis sizes, row height, bar sizing and every label
  font are configurable.

## Installation

```bash
dotnet add package BlazorResourceTimeline
```

Targets `net8.0`, `net9.0`, and `net10.0`, for both Blazor WebAssembly and
Blazor Server / interactive-render-mode apps.

No script or stylesheet registration is needed: the JavaScript engine is imported
on demand from `_content/BlazorResourceTimeline/`, and the component's scoped CSS
arrives through the framework's own bundle. That bundle is linked by every Blazor
template already - just make sure your host page keeps its

```html
<link href="YourApp.styles.css" rel="stylesheet" />
```

line (with `YourApp` being your app's assembly name).

### Trimming

The assembly is marked trim-compatible, so trimmed apps (Blazor WebAssembly
trims on publish) shrink it rather than skipping it. The types crossing the
JavaScript interop boundary are rooted in an embedded trimming descriptor, so
every option and allocation property keeps working after trimming - nothing
needs configuring on your side.

Ahead-of-time (AOT) compilation is not declared: interop marshalling relies on
reflection-based `System.Text.Json`, so the component is not AOT-safe.

## Quick start

Add the component and give it a `Config`:

```razor
@using BlazorResourceTimeline

<div style="height: 600px;">
    <BlazorResourceTimeline Config="_config"
                            OnSelectionChanged="OnSelectionChanged" />
</div>

@code {
    private BlazorResourceTimelineConfig? _config;

    protected override void OnInitialized()
    {
        _config = new BlazorResourceTimelineConfig
        {
            StartDate = DateTimeOffset.UtcNow.Date,
            EndDate = DateTimeOffset.UtcNow.Date.AddDays(1),
            Resources =
            [
                new() { Id = "gate-a1", Name = "Gate A1" },
                new() { Id = "gate-a2", Name = "Gate A2" },
            ],
            Allocations =
            [
                new()
                {
                    Id = "f-100",
                    ResourceId = "gate-a1",
                    StartTime = DateTimeOffset.UtcNow.Date.AddHours(8),
                    EndTime = DateTimeOffset.UtcNow.Date.AddHours(10),
                    TextAbove = "LH441",
                },
            ],
        };
    }

    private void OnSelectionChanged(BlazorResourceTimelineAllocation[] selected)
    {
        // selected are the same instances you supplied in Config.Allocations.
    }
}
```

The component sizes itself to its container, so give the wrapping element a
height.

> **Note:** `Config` is compared by reference. Assign a *new*
> `BlazorResourceTimelineConfig` instance to trigger a re-render, or call
> `ReloadAsync()` after mutating the existing one in place.

## Renderers

One engine owns the data, layout, hit-testing and interaction; only the painting
step differs. Pick it with `Options.Renderer`, and switch at runtime by assigning
a new `Options` instance - data, events and keyboard behavior are identical
across all three.

| `Renderer` | Output | Best for |
| --- | --- | --- |
| `Canvas` *(default)* | Immediate-mode 2D drawing, HiDPI/Retina-crisp via `ResizeObserver` + `device-pixel-content-box` | Dense boards; the fastest option |
| `Svg` | Resolution-independent vector nodes | Inspecting, copying or printing the scene |
| `Html` | One real DOM element per visible bar, carrying `data-bar-id` | Styling bars with your own CSS |

All three cull to the visible viewport every frame, so cost tracks what is on
screen rather than the size of the dataset.

```razor
<BlazorResourceTimeline Config="_config" Options="_options" />

@code {
    private BlazorResourceTimelineOptions _options = new()
    {
        Renderer = BlazorResourceTimelineRendererType.Svg,
    };
}
```

## Configuration (`Options`)

Pass a `BlazorResourceTimelineOptions` to customize appearance and behavior
(dimensions, fonts, colors, time zone, zoom scale). Assign a new `Options`
instance to re-apply at runtime (e.g. to switch themes or time zone):

```razor
<BlazorResourceTimeline Config="_config" Options="_options" />

@code {
    private BlazorResourceTimelineOptions _options = new()
    {
        TimeZone = "UTC",
        ResourceHeight = 44, // minimum row height; rows grow to fit stacked bars
        BarHeight = 8,
        BarMargin = 2, // gap between bars that overlap in time on the same row
        Colors = new() { Bar = "#74c0fc", Now = "#e03131" },
    };
}
```

Every property is nullable, so a partial instance overrides only what it sets:
values left `null` keep the renderer's defaults. Note that re-applying `Options`
*merges* - a `null` property keeps whatever was applied before, rather than
resetting it to the default.

## Theming and dark mode

`Options.Colors` (`BlazorResourceTimelineColors`) covers everything the renderer
paints - backgrounds, axis borders, ticks and labels, grid lines, bar fill,
selected fill/outline, bar labels, the "now" line, the marquee rectangle, the
focus ring and the tooltip. Assigning a new `Options` instance repaints
immediately, which is all a theme toggle needs:

```razor
<BlazorResourceTimeline Config="_config" Options="_options" />

@code {
    private bool _dark;
    private BlazorResourceTimelineOptions _options = new() { Colors = Light };

    private void ToggleTheme()
    {
        _dark = !_dark;
        // A new instance: Options is compared by reference.
        _options = new BlazorResourceTimelineOptions { Colors = _dark ? Dark : Light };
    }

    private static readonly BlazorResourceTimelineColors Light = new()
    {
        ContentBg = "#ffffff", AxisBg = "#f8f9fa", AxisBorder = "#dee2e6",
        Tick = "#adb5bd", Label = "#495057", DateLabel = "#212529", Grid = "#e9ecef",
        Bar = "#74c0fc", BarSelected = "#4dabf7", BarSelectedBorder = "#1971c2",
        BarLabel = "#495057", Now = "#e03131",
        SelectionFill = "rgba(77, 171, 247, 0.18)", SelectionBorder = "#4dabf7",
        Focus = "#1971c2", TooltipBg = "#212529", TooltipText = "#ffffff",
    };

    private static readonly BlazorResourceTimelineColors Dark = new()
    {
        ContentBg = "#1a1d21", AxisBg = "#141618", AxisBorder = "#2c3035",
        Tick = "#6c757d", Label = "#adb5bd", DateLabel = "#e9ecef", Grid = "#2c3035",
        Bar = "#4dabf7", BarSelected = "#74c0fc", BarSelectedBorder = "#a5d8ff",
        BarLabel = "#ced4da", Now = "#ff6b6b",
        SelectionFill = "rgba(77, 171, 247, 0.22)", SelectionBorder = "#74c0fc",
        Focus = "#74c0fc", TooltipBg = "#f8f9fa", TooltipText = "#212529",
    };
}
```

> **Note:** colors are *merged*, not replaced - a `null` entry keeps whatever was
> applied before, not the built-in default. That is convenient for tweaking one
> color, but when swapping between themes send a **complete** palette, otherwise
> stray colors from the previous theme stick around.

## Bar appearance

Beyond its time span, each `BlazorResourceTimelineAllocation` can carry its own
presentation:

| Property | Effect |
| --- | --- |
| `Color` | CSS color for the bar fill (falls back to `Colors.Bar`). |
| `Height` | Per-bar height in pixels (falls back to `Options.BarHeight`). Edge bars share it. |
| `TextAbove` / `TextBelow` | Labels centered above / below the bar. |
| `TextStart` / `TextEnd` | Labels just outside the start / end edge. |
| `Icons` | Images or data-URI SVGs anchored `Start`, `End`, `Above` or `Below`; several at one position lay out side by side, growing away from the bar. |
| `StartBar` / `EndBar` | Decorative "edge" bars extending before the start / after the end, each with its own `Duration` and `Color` - typically delays. |
| `Tooltip` | Hover text (see [Tooltips](#tooltips)). |

```csharp
new BlazorResourceTimelineAllocation
{
    Id = "f-100",
    ResourceId = "gate-a1",
    StartTime = start,
    EndTime = start.AddHours(2),
    Color = "#74c0fc",
    Height = 12,
    TextAbove = "LH441",
    TextEnd = "FRA",
    // 25 minutes late off-blocks, drawn in red after the planned end.
    EndBar = new() { Duration = TimeSpan.FromMinutes(25), Color = "#e03131" },
    Icons = [new() { Source = "/icons/warning.svg", Position = BlazorResourceTimelineBarIconPosition.Start }],
}
```

Labels and icons are skipped on bars narrower than `Options.MinBarWidthForLabels`,
so zoomed-out boards stay readable. Edge bars and icons are decoration only -
they are not selectable and never become hit targets.

## Editing

Set `Options.Editable = true` to let users move and resize allocations directly
on the timeline (mouse/pen):

- **Move** – drag a bar's body to shift it in time. Unless
  `AllowResourceChange` is `false`, dragging vertically also reassigns it to the
  resource row under the pointer.
- **Resize** – drag within `EditResizeHandlePx` of a bar's start or end edge.
- **Snapping** – moves and resizes snap to `EditSnapMinutes` (default 15; set
  `0` for continuous). A resize never shrinks a bar below
  `EditMinDurationMinutes`.

```razor
<BlazorResourceTimeline Config="_config"
                        Options="_options"
                        OnAllocationChanged="OnAllocationChanged" />

@code {
    private BlazorResourceTimelineOptions _options = new()
    {
        Editable = true,
        EditSnapMinutes = 15,
        // AllowResourceChange = false, // to lock rows and only edit in time
    };

    private void OnAllocationChanged(BlazorResourceTimelineAllocation edited)
    {
        // `edited` is the same instance from Config.Allocations, already updated
        // in place with its new StartTime/EndTime/ResourceId. Persist it here.
    }
}
```

Editing is also keyboard accessible: focus a bar and use `Alt`+arrows to move it,
`Alt`+`Shift`+`←`/`→` to resize the end edge, `Alt`+`Shift`+`↑`/`↓` to resize the
start edge, and `Alt`+`↑`/`↓` to change resource.

The renderer applies edits optimistically (the bar updates immediately). To
reject an edit, revert the instance in your handler and call `ReloadAsync()`.

## Context menu (right-click)

Right-clicking the timeline suppresses the browser's own menu and raises
`OnContextMenu` with everything needed to show your own. The args identify what
was under the pointer and where the click happened on screen:

| Property | Description |
| --- | --- |
| `Allocation` | The bar under the pointer, or `null` when the click missed every bar. Your own instance from `Config`. |
| `Resource` | The row under the pointer; `null` below the last row. |
| `Time` | The time at the pointer's horizontal position; `null` on the resource axis (which has no time coordinate). |
| `ClientX` / `ClientY` | Viewport coordinates of the click, suited to a `position: fixed` menu. |

It fires for bars, for empty space in the content area, and for resource-axis
rows - but not for the time axis. Right-clicking never changes the selection, so
an existing multi-selection survives opening a menu.

```razor
<BlazorResourceTimeline Config="_config" OnContextMenu="ShowMenu" />

@if (_menu is { } menu)
{
    <div class="my-menu" style="position:fixed;left:@((int)menu.ClientX)px;top:@((int)menu.ClientY)px">
        @if (menu.Allocation is { } bar)
        {
            <button @onclick="() => Delete(bar)">Delete @bar.Id</button>
        }
        else if (menu.Time is { } time)
        {
            <button @onclick="() => Create(menu.Resource, time)">New allocation here…</button>
        }
    </div>
}

@code {
    private BlazorResourceTimelineContextMenuArgs? _menu;

    private void ShowMenu(BlazorResourceTimelineContextMenuArgs args) => _menu = args;
}
```

Remember to close the menu yourself (for example from a backdrop click or
`Escape`) - the component only reports the event.

## Overlapping allocations

Allocations that overlap in time on the same resource row are laid out in
vertical **lanes** rather than drawn on top of each other. Overlapping bars are
grouped into clusters, each bar takes the first lane free at its start time, and
the cluster is centered on the row's center line. A bar that overlaps nothing
keeps sitting exactly on that line, so simple rows look unchanged.

`Options.BarMargin` (default `2`) sets the vertical gap between stacked bars;
`0` stacks them touching. Lane positions account for the **actual height** of the
bars in each lane - `Options.BarHeight` or an allocation's own `Height` - so a
cluster mixing bar heights still lays out without overlap. Bars that merely touch
(one ends the instant the next starts) are not treated as overlapping.

```razor
<BlazorResourceTimeline Config="_config" Options="_options" />

@code {
    private BlazorResourceTimelineOptions _options = new()
    {
        BarHeight = 10,
        BarMargin = 4, // 4 px between bars that overlap in time
    };
}
```

**Rows grow to fit their stack**, so a dense cluster never spills into the
neighbouring row. `Options.ResourceHeight` is the *minimum* row height: a row
whose tallest cluster needs `sum(lane heights) + BarMargin × (lanes − 1)` pixels
grows to that height plus the same top/bottom padding a single default-height bar
has in a minimum-height row. A row whose bars never overlap stays exactly at
`ResourceHeight`, so simple boards look unchanged, and the resource column,
hit-testing, keyboard navigation and the `ResourceTemplate` overlay all follow
the per-row heights.

## Resource-column template

By default the sticky resource column is drawn by the renderer (fast, plain text).
For richer, interactive content set `ResourceTemplate`: the renderer then stops
drawing the labels and an HTML overlay renders your template once per visible row
(row counts are bounded, so this stays cheap). Group rows automatically get an
expand/collapse chevron before your content, and the overlay follows vertical
scroll. The context exposes the resource, its `Depth`, and its group state.

```razor
<BlazorResourceTimeline Config="_config">
    <ResourceTemplate Context="row">
        <span class="res-cell">
            <strong>@row.Resource.Name</strong>
            @if (row.HasChildren) { <span class="badge">group</span> }
        </span>
    </ResourceTemplate>
</BlazorResourceTimeline>
```

## On-demand (windowed) loading

For datasets too large to send up front, set `LoadAllocationsAsync`. The timeline
then requests only the allocations overlapping the currently needed time window
(the visible range widened by a buffer) and calls the delegate again as the user
scrolls or zooms toward the edge of the loaded window. `Config` still supplies the
resources and the overall `StartDate`/`EndDate`; its `Allocations` are ignored.

```razor
<BlazorResourceTimeline Config="_config" LoadAllocationsAsync="LoadWindowAsync" />

@code {
    // Return every allocation whose span overlaps the requested window, across
    // all resources. Query your database/service here.
    private async Task<IReadOnlyList<BlazorResourceTimelineAllocation>> LoadWindowAsync(
        BlazorResourceTimelineWindow window)
    {
        return await _repository.GetAllocationsAsync(window.Start, window.End);
    }
}
```

Requests are debounced, coalesced, and tagged so a slow fetch superseded by newer
scrolling is discarded rather than overwriting the current window. Tune the buffer
and refetch sensitivity with `Options.WindowBufferFactor`,
`Options.WindowRefetchThreshold` and `Options.WindowDebounceMs`.

## Resource hierarchy

Resources form a flat list by default. Set a resource's `ParentId` to the `Id` of
another resource to nest it, building a multi-level tree. A resource that has
children renders as a collapsible **group header** (indented by its depth, with a
chevron); clicking the header row toggles it, and `Collapsed = true` starts a
group collapsed. Groups can still own their own allocations. Sibling and root
order follows the order of the resources list.

```csharp
var resources = new List<BlazorResourceTimelineResource>
{
    new() { Id = "dc",   Name = "Data Center" },
    new() { Id = "srv",  Name = "Servers",   ParentId = "dc" },
    new() { Id = "s1",   Name = "Server-01", ParentId = "srv" },
    new() { Id = "s2",   Name = "Server-02", ParentId = "srv" },
    new() { Id = "db",   Name = "Databases", ParentId = "dc", Collapsed = true },
    new() { Id = "d1",   Name = "Database-01", ParentId = "db" },
};
```

## Tooltips

Hovering a bar (mouse/pen) shows a tooltip after `Options.TooltipDelayMs`
(default 300 ms). Set an allocation's `Tooltip` to control the text, or leave it
`null` for a default built from the bar's labels, resource name and time range.
Disable tooltips entirely with `Options.ShowTooltips = false`, and theme them via
`Colors.TooltipBg` / `Colors.TooltipText`.

## Programmatic API

Capture the component with `@ref` to drive it from code:

| Method | Description |
| --- | --- |
| `ReloadAsync()` | Re-sends the current `Config` even if the reference is unchanged. |
| `ClearSelectionAsync()` | Clears the current selection. |
| `GetSelectedBarsAsync()` | Returns the selected allocations, in selection order. |
| `GoToTodayAsync()` | Centers "now" in view (if within range). |
| `ScrollToTimeAsync(unixMs)` | Centers the given time in view. |
| `ZoomInAsync()` / `ZoomOutAsync()` | Zoom around the viewport center. |
| `SetPixelsPerHourAsync(value?)` | Sets an explicit scale, or `null` for auto. |
| `ResetZoomAsync()` | Returns to the auto/config scale. |
| `GetPixelsPerHourAsync()` | Current horizontal scale. |

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `←` / `→` | Move between allocations in the focused row |
| `↑` / `↓` | Move to the nearest allocation in the adjacent row |
| `Home` / `End` | First / last allocation in the row |
| `Enter` | Select the focused bar (`Ctrl`/`Cmd`+`Enter` toggles) |
| `Space` | Toggle the focused bar in a multi-selection |
| `Escape` | Clear the selection |
| `PageUp` / `PageDown` | Pan the time axis |
| `Ctrl`/`Cmd` + `+` / `-` / `0` | Zoom in / out / reset |
| `Alt` + `←` / `→` | Move the focused bar earlier / later (editing only) |
| `Alt` + `Shift` + `←` / `→` | Resize the focused bar's end edge (editing only) |
| `Alt` + `Shift` + `↑` / `↓` | Resize the focused bar's start edge (editing only) |
| `Alt` + `↑` / `↓` | Move the focused bar to the previous / next resource (editing only) |

## Notable parameters

- `Config` - resources, time window, and allocation bars.
- `Options` - visual/behavioral configuration.
- `OnSelectionChanged` - raised with the selected allocations (your own instances).
- `OnAllocationChanged` - raised after a move/resize (editing) with the updated instance.
- `OnContextMenu` - raised on right-click with the bar/resource/time under the
  pointer and the click's viewport coordinates.
- `AriaLabel` - accessible name (default `"Resource timeline"`).
- `LoadBatchSize` - allocations per interop call for streaming large datasets
  (default `10000`; `0` sends everything at once).
- `LoadingMinDurationMs` - minimum time the loading overlay stays visible
  (default `0`).
- `TopStartContent` / `LoadingContent` - custom render fragments for the
  top-start corner and the loading overlay.

## Demo

`src/Demo` is a Blazor WebAssembly playground for everything above: dataset size
(7 to 365 days), renderer, bar height and margin, editing, on-demand loading, the
custom resource column, time zone, zoom, and a light/dark theme toggle - plus a
live view of the selection, the last edit and the last context-menu action.

```bash
dotnet run --project src/Demo
```

## Repository layout

- `src/BlazorResourceTimeline` - the component library (C# component, models and
  the JavaScript engine/renderers under `wwwroot`).
- `src/Demo` - the Blazor WebAssembly demo.
- `src/Tests/BlazorResourceTimeline.Tests` - .NET unit tests.
- `src/Tests/js` - rendering-engine tests (node's built-in test runner).

## Building

```bash
dotnet build src/BlazorResourceTimeline.slnx
dotnet test  src/BlazorResourceTimeline.slnx
dotnet run --project src/Demo
```

The rendering engine is JavaScript and is covered by node's built-in test runner
(no npm dependencies):

```bash
node --test "src/Tests/js/**/*.test.mjs"
```

## Releasing

Packing and publishing are driven by the tag: pushing a `v*` tag builds, tests,
packs and pushes to NuGet, taking the package version from the tag name
(`v1.2.3` produces `1.2.3`).

```bash
dotnet pack src/BlazorResourceTimeline/BlazorResourceTimeline.csproj -c Release -o artifacts
```

## License

[MIT](https://github.com/msynk/BlazorResourceTimeline/blob/main/LICENSE)
