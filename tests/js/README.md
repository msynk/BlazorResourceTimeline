# Rendering-engine tests

Tests for the JavaScript timeline engine (`src/BlazorResourceTimeline/wwwroot/`).

```bash
node --test "tests/js/**/*.test.mjs"
```

Requires Node 20+. There are no npm dependencies and no `package.json` — these
use node's built-in test runner and `node:assert`, so nothing needs installing
and CI only has to add a `setup-node` step.

## What is covered

| File | Area |
| --- | --- |
| `time-axis.test.mjs` | Zoned hour boundaries, DST transitions, tick density |
| `allocation-index.test.mjs` | Per-resource index, stacking lanes, incremental re-index on edit |
| `engine-state.test.mjs` | Resource hierarchy, coordinate mapping, options, selection |

`helpers/engine-fixture.mjs` builds an engine on the prototype with only the
state the DOM-independent methods read, so these run under plain Node with no
browser or DOM shim.

## Conventions

- **Test against an oracle, not against the implementation.** The hour-boundary
  tests compare with a deliberately naive minute-by-minute scan. When both the
  code and its test encode the same clever idea, they agree on the same bug.
- **Prefer absolute invariants.** `indexViolations()` checks properties that
  must hold on their own terms (rows sorted, scan bounds cover their contents,
  nothing lost or duplicated) rather than only diffing against a full rebuild —
  a bug present in both paths passes a differential check.
- **Anything needing real layout belongs in a browser.** Hit-testing against
  painted pixels, scrollbar clamping and renderer output are not covered here.
