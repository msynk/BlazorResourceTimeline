// Time-zone-aware date arithmetic for the timeline axis.
//
// Every boundary the axis draws - midnights, hour ticks - is a *wall-clock*
// concept in some IANA zone, while the timeline itself is laid out in absolute
// instants. This module is the only place that converts between the two.
//
// It holds no timeline state, so it can be constructed and exercised on its own
// (see tests/js/time-axis.test.mjs). The formatters are cached because building
// an Intl.DateTimeFormat is comparatively expensive and the axis converts many
// boundaries per frame.

export class ZonedTime {
    // `timeZone` is an IANA id (e.g. "Europe/Berlin"), or null for the viewer's
    // local zone. `locale` is a BCP 47 tag for human-facing labels, or null for
    // the viewer's locale.
    constructor(timeZone = null, locale = null) {
        this.timeZone = timeZone || null;
        this.locale = locale || null;

        const zone = timeZone || undefined;
        const loc = locale || undefined;

        // Numeric wall-clock parts in the zone, used for day/hour math and the
        // hour label. en-US + h23 guarantees parseable 0-23 hour values
        // regardless of the display locale configured above.
        const partsOpts = {
            hourCycle: 'h23',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        };
        if (zone) partsOpts.timeZone = zone;
        this._partsDtf = new Intl.DateTimeFormat('en-US', partsOpts);

        // Localized day label; configured (or viewer) locale for i18n, zone for
        // correctness.
        const dateOpts = { weekday: 'short', month: 'short', day: 'numeric' };
        if (zone) dateOpts.timeZone = zone;
        this._dateDtf = new Intl.DateTimeFormat(loc, dateOpts);

        // Spoken/short date+time, used for screen-reader announcements, the
        // drag ghost readout and tooltips.
        const dateTimeOpts = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
        if (zone) dateTimeOpts.timeZone = zone;
        this._dateTimeDtf = new Intl.DateTimeFormat(loc, dateTimeOpts);
    }

    // Wall-clock parts of an instant, in this zone.
    parts(ts) {
        const parts = this._partsDtf.formatToParts(ts);
        const map = {};
        for (const p of parts) {
            if (p.type !== 'literal') map[p.type] = p.value;
        }
        let hour = +map.hour;
        if (hour === 24) hour = 0; // some engines emit '24' at midnight
        return {
            year: +map.year, month: +map.month, day: +map.day,
            hour, minute: +map.minute, second: +map.second
        };
    }

    // Offset (zone - UTC, in ms) in effect at the given instant.
    offsetMs(ts) {
        const p = this.parts(ts);
        const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
        return asUtc - Math.floor(ts / 1000) * 1000;
    }

    // Converts a wall-clock time in this zone to an instant. Two-pass so it
    // resolves correctly across a DST offset change.
    wallClockToTs(year, month, day, hour, minute, second) {
        const guess = Date.UTC(year, month - 1, day, hour, minute, second);
        const offset1 = this.offsetMs(guess);
        let ts = guess - offset1;
        const offset2 = this.offsetMs(ts);
        if (offset2 !== offset1) {
            ts = guess - offset2;
        }
        return ts;
    }

    // Local midnight of the day containing the given instant.
    startOfDay(ts) {
        const p = this.parts(ts);
        return this.wallClockToTs(p.year, p.month, p.day, 0, 0, 0);
    }

    // First local midnight strictly after the given day start. Date.UTC
    // normalizes month/year rollover.
    nextDay(dayStart) {
        const p = this.parts(dayStart);
        const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
        return this.wallClockToTs(
            next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0);
    }

    // Hour boundaries within [visStart, visEnd] that land on a multiple of
    // `step` wall-clock hours, as [{ ts, hour }]. `step` must divide 24, which
    // is what makes step multiples align with local midnight.
    //
    // Iteration runs in wall-clock space (instant + zone offset), advancing by
    // the full step and converting back, so it costs one zone lookup per
    // *emitted* boundary instead of several per intervening hour. Callers pick
    // the step to keep boundaries a readable distance apart, which bounds the
    // iteration count by the viewport width at any zoom - no iteration cap
    // needed.
    //
    // DST: a spring-forward skips a wall-clock hour, which is detected and not
    // emitted. A fall-back repeats one, and only its first occurrence is
    // emitted (so an hour-level axis shows a two-hour gap between the two
    // surrounding ticks on that day) - long-standing behavior, not worth the
    // bookkeeping to change.
    hourBoundaries(visStart, visEnd, step) {
        const out = [];
        if (!(step > 0)) return out;

        const HOUR_MS = 3600000;
        const DAY_MS = 86400000;
        const stepMs = step * HOUR_MS;

        let offset = this.offsetMs(visStart);
        // First aligned wall-clock boundary at or after the window start.
        let wall = Math.ceil((visStart + offset) / stepMs) * stepMs;

        for (;;) {
            // Resolve the wall-clock boundary back to an instant, re-checking
            // the offset so a DST transition inside the window stays aligned.
            let ts = wall - offset;
            const actual = this.offsetMs(ts);
            let exists = true;
            if (actual !== offset) {
                offset = actual;
                ts = wall - offset;
                // The offset only disagrees at a transition. At a spring-forward
                // the wall-clock hour is skipped entirely and has no instant at
                // all (e.g. 02:00 never happens in New York on a March
                // transition day); emitting it would put a mislabeled tick an
                // hour off. Round-trip once more to tell the two cases apart.
                exists = this.offsetMs(ts) === offset;
            }
            if (ts > visEnd) break;
            if (exists && ts >= visStart) {
                out.push({ ts, hour: Math.floor((((wall % DAY_MS) + DAY_MS) % DAY_MS) / HOUR_MS) });
            }
            wall += stepMs;
        }
        return out;
    }

    // Localized day label for the date row ("Mon, Jul 20").
    formatDate(ts) {
        return this._dateDtf.format(ts);
    }

    // Short localized date + time, for announcements, tooltips and the ghost.
    formatDateTime(ts) {
        return this._dateTimeDtf.format(ts);
    }
}
