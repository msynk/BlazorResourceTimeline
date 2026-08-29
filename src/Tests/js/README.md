# Rendering-engine tests

Tests for the JavaScript timeline engine (`src/BlazorResourceTimeline/wwwroot/`).

```bash
node --test "src/Tests/js/**/*.test.mjs"
```

Requires Node 20+. There are no npm dependencies and no `package.json` - these
use node's built-in test runner and `node:assert`, so nothing needs installing
and CI only has to add a `setup-node` step.

## What is covered

| File | Area |
| --- | --- |
| `time-axis.test.mjs` | Zoned hour boundaries, DST transitions, tick density, `addDays` calendar steps, wall-clock snap, `Hour12`, `FirstDayOfWeek` |
| `allocation-index.test.mjs` | Per-resource index, stacking lanes, incremental re-index on edit, invalid-row sanitize, `MaxStackLanes` overflow, windowed merge by id |
| `engine-state.test.mjs` | Resource hierarchy, coordinate mapping, row heights, options, selection, resource-axis resize clamp, upper-lane marquee, Shift-range select |
| `scene.test.mjs` | Scene building, and the stale state pooled/refilled bar nodes can leak between frames |
| `view-scroll.test.mjs` | Where the viewport lands on the first load and across reloads, the `panByDays` day/week steps (24-hour, `panToDayStart`, and per-call override), `zoomToDays` fitting N days into the viewport, the "now" indicator's refresh timer, `OnViewChanged`, and `scrollToAllocation` |
| `tooltip.test.mjs` | Show delay, subject switching and viewport-edge flipping, against a minimal DOM stub |
| `hit-test.test.mjs` | `_barAt` click tolerance, resize handle vs move, locked bars, stacked-lane Y, overflow hits |
| `renderer-contract.test.mjs` | `buildScene()` bar ids, non-overlap within a row, weekend/off-hour bands, `Hour12` tick labels |
| `edit-commit.test.mjs` | Move/resize commit, overlap refuse, delete, multi-move accept/reject |

`helpers/engine-fixture.mjs` builds an engine on the prototype with only the
state the DOM-independent methods read, so these run under plain Node with no
browser or DOM shim.

## Conventions

- **Test against an oracle, not against the implementation.** The hour-boundary
  tests compare with a deliberately naive minute-by-minute scan. When both the
  code and its test encode the same clever idea, they agree on the same bug.
- **Prefer absolute invariants.** `indexViolations()` checks properties that
  must hold on their own terms (rows sorted, scan bounds cover their contents,
  nothing lost or duplicated) rather than only diffing against a full rebuild -
  a bug present in both paths passes a differential check.
- **Anything needing real layout belongs in a browser.** Hit-testing is covered
  here against engine geometry (`_barAt`, marquee Y, overflow labels). Renderer
  *paint* (canvas pixels, scrollbar clamping) is not; `renderer-contract.test.mjs`
  asserts the display list instead. Do not add Playwright unless that fixture
  approach fails.
