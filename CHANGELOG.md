# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `OnClick` and `OnDoubleClick` (`BlazorResourceTimelinePointerArgs`): surface
  and viewport position, time, resource, the bar (if any), overflow bars when a
  `+N` label is hit, hit area (content / resource axis / time axis / corner),
  and modifier keys. A double-click also raises `OnClick` once per click.
  Marquee, edit and pan gestures do not fire them. Right-click (`OnContextMenu`)
  now uses the same payload (`BlazorResourceTimelineContextMenuArgs` derives
  from `PointerArgs`).

### Fixed

- A parent re-render during the first data load (`OnViewChanged`, a post-mount
  Options swap, …) no longer replays `setData` for the same `Config`. The demo
  was painting the timeline two or three times on refresh because theme sync
  and the view callback both re-rendered the page while the first load was
  still in flight.

## [0.6.0] - 2026-08-29

### Added

- `BlazorResourceTimelineAllocation.Data`: optional `JsonElement` host payload
  (for example `JsonSerializer.SerializeToElement(new { flightNo = "LH441" })`).
  The engine never reads it and does not paint it; the same instance still
  carries it after selection.
- Cancellable edits: `OnAllocationChanging` can return `false` to snap a bar
  back without `ReloadAsync()`. `Allocation.Locked` bars stay selectable but
  cannot be moved or resized. `Options.AllowOverlap = false` refuses a drop
  onto another unlocked bar on the same resource (touching ends are allowed).
- `UpsertAllocationsAsync` / `RemoveAllocationsAsync`: patch bars by id
  without a full `setData` (selection and focus of other bars stay put).
- `Options.EmptyDragAction.Create`: drag empty content (while editing) to draw a
  new bar. The host assigns the id via `OnAllocationCreating`; Ctrl/Cmd-drag
  still marquees.
- `OnViewChanged` (`BlazorResourceTimelineView`: `Start`, `End`, `PixelsPerHour`)
  after scroll, zoom or layout, at most once per frame.
- `SelectAsync`, `ScrollToAllocationAsync`, `ScrollToResourceAsync`.
- `Allocation.ClassName` on the HTML renderer; `TooltipTemplate` overlay on every
  renderer (canvas included).
- Working-time wash: `NonWorkingDays`, `WorkingHoursStart` / `WorkingHoursEnd`,
  `Colors.NonWorking` (visual only).
- `Options.Hour12` (12-hour hour-row labels) and `Options.FirstDayOfWeek`.
- `Options.MaxStackLanes`: cap stacked lanes and draw a `+N` overflow label.
- Delete (`AllowDelete` + Delete/Backspace + `OnAllocationsDeleting`), copy/paste
  (`OnAllocationsCopying`), and multi-bar move (`OnAllocationsChanging`).
  Shift-click selects a contiguous range; marquee hit-tests stacked lanes in 2D.
- Invalid allocations (`end <= start`, empty id, unknown resource, duplicate ids)
  are skipped with a one-time warning instead of crashing paint.

### Changed

- Edit snap now lands on wall-clock multiples of `EditSnapMinutes` from local
  midnight in `Options.TimeZone` (`SnapToTimeZone` default `true`, including
  across DST). Hosts that need the previous Unix-epoch grid set
  `SnapToTimeZone = false`.
- Windowed `LoadAllocationsAsync` merges by id instead of replacing the set, so
  selection and focus survive a refetch for bars that remain in range.

### Fixed

- `PanToDayStart` no longer realigns to the same midnight (or skips a day going
  back) when the leading edge sits a fraction of a pixel before that midnight
  after native `scrollLeft` quantization.

## [0.5.0] - 2026-08-29

### Added

- Resizable resource column: drag the divider at the right edge of the left
  panel (or focus it and use the arrow keys) to change its width. The gesture
  is on by default, clamped by `Options.ResourceAxisMinWidth` /
  `Options.ResourceAxisMaxWidth` and the viewport, and reports the committed
  width through `OnResourceAxisWidthChanged`. Set
  `Options.ResourceAxisResizable = false` to keep a fixed column.
- `Options.PanToDayStart`: `PanByDaysAsync` lands the leading edge on a local
  midnight (the start of the day N calendar days away in `Options.TimeZone`)
  instead of shifting by exactly 24 hours. DST 23- and 25-hour days count as
  one step. Off by default, so existing hosts keep the 24-hour behaviour. A
  non-null `panToDayStart` argument on `PanByDaysAsync` overrides the option
  for that call.

## [0.4.1] - 2026-08-25

### Fixed

- Removing the timeline while it is still starting up no longer throws. Its
  first render imports the JS engine and creates the renderer with a
  `DotNetObjectReference` to the component, so a host that navigates away (or
  remounts via `@key`) in that window used to marshal an already-disposed
  reference and surface `ObjectDisposedException` in the host's error boundary.
  Initialization now stops at the first await that resumes after disposal, and
  releases the module/renderer that arrived too late for `DisposeAsync` to see.
- A data load that is in flight when the component is disposed stops instead of
  pushing the rest of the load into a renderer that no longer exists, and the
  internal load gates are no longer disposed underneath it (disposing a
  `SemaphoreSlim` throws into everything waiting on or releasing it).
- `DisposeAsync` is idempotent: the JS teardown runs once, no matter how many
  times the host disposes the component.

### Added

- `PanByDaysAsync(days)`: steps the view forward or back by whole days at the
  current zoom, keeping the same time of day at the leading edge. Returns
  `false` when the view is already against that end of the range. Hosts that
  want keyboard day/week steps call this from their own key handler.
- `ZoomToDaysAsync(days)`: zooms so exactly that many days fill the current
  viewport, keeping the time under the center fixed. The resulting scale is
  clamped to `MinPixelsPerHour` / `MaxPixelsPerHour`. Returns the new scale in
  pixels per hour.

### Fixed

- Clicking the timeline now gives it keyboard focus. The press handler cancels
  the `pointerdown` default action to stop a native selection from starting
  under a drag, which also suppressed the browser's own focusing, so the
  timeline could previously only be reached with `Tab` and every keyboard
  shortcut appeared dead after a click.
- Day titles on the time axis no longer stack when a midnight scrolls into
  view. The incoming day's label pushes the previous title left, and it
  slides out of the viewport instead of drawing on top of the new one.

## [0.3.0] - 2026-08-15

### Added

- `Options.AutoScrollToNow`: centers the current time in the view as soon as the
  first data load is laid out, so a timeline meant to open "at now" no longer
  needs a `GoToTodayAsync()` call after rendering. Later loads leave the
  viewport alone.
- `Options.PreserveScrollOnReload`: keeps a data reload showing what it was
  showing - the time at the left edge of the content area and the row at the
  top - restored by time and resource id, so it survives a reload that changes
  the range, the scale or the row list.
- `Options.NowLineRefreshMs`: how often the "now" indicator is repainted to keep
  up with the wall clock on an idle timeline (default 60000, as before; `0`
  stops the ticking).
- `BarIconPosition.Center`: anchors a bar icon on top of the allocation bar,
  centered horizontally and vertically. Several centered icons lay out side by
  side as one group centered on the bar.
- `BarIcon.Inside`: draws an icon within the bar instead of beside it, aligned
  against the edge its `Position` names. Inside icons take no room outside the
  bar, so the labels around it stay where they were.

## [0.2.0] - 2026-07-28

### Added

- `Options.ShowUtcTime`: an optional second hour row on the time axis, in UTC,
  drawn below the day labels and above the row that follows `Options.TimeZone`.
  It is rendered exactly like that row but on UTC's own hour boundaries, so its
  numbers sit shifted horizontally by any minutes in the zone's offset.
  Supported by all three renderers.

## [0.1.0] - 2026-07-26

First public release.

### Added

- `BlazorResourceTimeline` component: a resource timeline / planner that draws a
  time axis horizontally, resources vertically, and allocation bars in between.
- Pluggable renderers selected via `Options.Renderer` - **Canvas** (default,
  HiDPI-aware), **SVG** and **HTML** - all driven by one shared engine, with
  per-frame culling and runtime switching.
- Zoom (`Ctrl`/`Cmd` + wheel, trackpad pinch, or the programmatic API) with
  adaptive tick and label density.
- Selection: click, `Ctrl`/`Cmd`-click toggle, and click-and-drag marquee.
- Opt-in editing (`Options.Editable`): drag to move in time or across resources,
  drag an edge to resize, with snapping, a minimum duration, and an
  `OnAllocationChanged` callback.
- Right-click support through `OnContextMenu`, reporting the bar, resource, time
  and viewport coordinates under the pointer.
- Automatic lane stacking for allocations that overlap in time on the same row,
  spaced by `Options.BarMargin`.
- Hover tooltips, custom or auto-generated, themable and disableable.
- Collapsible multi-level resource hierarchy via `Resource.ParentId`.
- On-demand (windowed) loading through `LoadAllocationsAsync`, with debounced,
  coalesced and superseded-request-safe fetches.
- `ResourceTemplate` for rich, interactive HTML in the resource column.
- Keyboard and screen-reader accessibility: focusable region with `role` and
  `aria-label`, arrow-key navigation, keyboard selection and editing, and
  live-region announcements.
- Time-zone-aware axes (IANA ids, DST-correct) with an optional `Locale`.
- Touch and pen input via Pointer Events.
- Streaming data load in batches (`LoadBatchSize`) for very large datasets.
- Theming and layout customization through `BlazorResourceTimelineOptions` and
  `BlazorResourceTimelineColors`, including a dark theme.
- Programmatic API: `ReloadAsync`, `ClearSelectionAsync`,
  `GetSelectedBarsAsync`, `GoToTodayAsync`, `ScrollToTimeAsync`, `ZoomInAsync`,
  `ZoomOutAsync`, `SetPixelsPerHourAsync`, `ResetZoomAsync` and
  `GetPixelsPerHourAsync`.
- Trimming support: the assembly is marked `IsTrimmable`, with the interop
  models rooted in an embedded ILLink descriptor so trimming cannot silently
  drop properties that only reflection-based serialization reads. AOT is not
  declared, since interop marshalling is reflection-based.

[Unreleased]: https://github.com/msynk/BlazorResourceTimeline/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/msynk/BlazorResourceTimeline/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/msynk/BlazorResourceTimeline/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/msynk/BlazorResourceTimeline/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/msynk/BlazorResourceTimeline/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/msynk/BlazorResourceTimeline/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/msynk/BlazorResourceTimeline/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/msynk/BlazorResourceTimeline/releases/tag/v0.1.0
