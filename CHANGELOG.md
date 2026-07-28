# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/msynk/BlazorResourceTimeline/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/msynk/BlazorResourceTimeline/releases/tag/v0.1.0
