using BlazorResourceTimeline.Models;

namespace BlazorResourceTimeline.Demo.Data;

/// <summary>
/// Produces realistic sample data for the demo: a set of resources,
/// a time range and allocation bars spread across that range with natural gaps.
/// </summary>
public static class DataGenerator
{
    private static readonly string[] DefaultResourceNames =
    [
        "Server-01", "Server-02", "Server-03", "Server-04", "Server-05",
        "Server-06", "Server-07", "Server-08", "Server-09", "Server-10",
        "Server-11", "Server-12", "Server-13", "Server-14", "Server-15",
        "Server-16", "Server-17", "Server-18", "Server-19", "Server-20",
        "Database-01", "Database-02", "Database-03", "Database-04",
        "Database-05", "Database-06", "Database-07", "Database-08",
        "Database-09", "Database-10", "Database-11", "Database-12",
        "Cache-01", "Cache-02", "Cache-03", "Cache-04",
        "Cache-05", "Cache-06", "Cache-07", "Cache-08",
        "Worker-01", "Worker-02", "Worker-03", "Worker-04",
        "Worker-05", "Worker-06", "Worker-07", "Worker-08",
        "Worker-09", "Worker-10", "Worker-11", "Worker-12",
        "Worker-13", "Worker-14", "Worker-15", "Worker-16",
        "API-Gateway-01", "API-Gateway-02", "API-Gateway-03", "API-Gateway-04",
        "Load-Balancer-01", "Load-Balancer-02", "Load-Balancer-03", "Load-Balancer-04",
        "Load-Balancer-05", "Load-Balancer-06", "Load-Balancer-07", "Load-Balancer-08"
    ];

    private const long OneDayMs = 24L * 60 * 60 * 1000;

    // Per resource-type abbreviation and color used to customize every bar.
    private static readonly Dictionary<string, (string Abbrev, string Color)> ResourceTypeInfo = new()
    {
        ["Server"] = ("SRV", "#1971c2"),
        ["Database"] = ("DB", "#2f9e44"),
        ["Cache"] = ("CCH", "#e8590c"),
        ["Worker"] = ("WRK", "#9c36b5"),
        ["API-Gateway"] = ("GW", "#0c8599"),
        ["Load-Balancer"] = ("LB", "#e03131")
    };

    private const string FallbackColor = "#868e96";

    // Colors applied based on each bar's position relative to "now":
    //   before now -> darkgreen, after now -> blue.
    private const string PastColor = "darkgreen";
    private const string FutureColor = "blue";

    // Delay (edge) bar color, shown at both ends of some past bars.
    private const string DelayColor = "red";

    // Fraction of past bars that receive start/end delay bars.
    private const double DelayProbability = 0.25;

    // Fraction of bars that receive one or more decorative icons.
    private const double IconProbability = 0.35;

    // Positions an icon can be anchored to, picked at random per icon.
    private static readonly BlazorResourceTimelineBarIconPosition[] IconPositions =
    [
        BlazorResourceTimelineBarIconPosition.Start,
        BlazorResourceTimelineBarIconPosition.End,
        BlazorResourceTimelineBarIconPosition.Above,
        BlazorResourceTimelineBarIconPosition.Below
    ];

    // A small palette of inline SVG icons, exposed as ready-to-use data URIs.
    // Using data URIs keeps the demo self-contained (no extra image files to
    // ship) while still exercising the real image-loading path in the renderer.
    private static readonly string[] IconSources =
    [
        // Amber warning triangle
        SvgDataUri("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M12 2 1 21h22L12 2z' fill='#f59f00'/><rect x='11' y='9' width='2' height='6' fill='#fff'/><rect x='11' y='17' width='2' height='2' fill='#fff'/></svg>"),
        // Green check circle
        SvgDataUri("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><circle cx='12' cy='12' r='11' fill='#2f9e44'/><path d='M6 12l4 4 8-8' stroke='#fff' stroke-width='2.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>"),
        // Yellow star
        SvgDataUri("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z' fill='#fcc419'/></svg>"),
        // Red flag
        SvgDataUri("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><rect x='4' y='2' width='2' height='20' fill='#495057'/><path d='M6 3h13l-3 4 3 4H6z' fill='#e03131'/></svg>"),
        // Blue lock
        SvgDataUri("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><rect x='5' y='10' width='14' height='11' rx='2' fill='#1971c2'/><path d='M8 10V7a4 4 0 0 1 8 0v3' stroke='#1971c2' stroke-width='2' fill='none'/></svg>"),
        // Purple lightning bolt
        SvgDataUri("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M13 2L4 14h6l-1 8 9-12h-6z' fill='#9c36b5'/></svg>")
    ];

    /// <summary>
    /// Builds resource rows from the provided names (or a default set), organized
    /// into a two-level hierarchy: a "Data Center" root, a group per resource type
    /// (Servers, Databases, ...) and the individual resources as leaves. Group and
    /// root rows carry no allocations of their own.
    /// </summary>
    public static List<BlazorResourceTimelineResource> GenerateResources(string[]? resourceNames = null)
    {
        var names = resourceNames ?? DefaultResourceNames;
        var list = new List<BlazorResourceTimelineResource>();

        const string rootId = "grp-root";
        list.Add(new BlazorResourceTimelineResource { Id = rootId, Name = "Data Center" });

        var groupIds = new Dictionary<string, string>();
        for (var i = 0; i < names.Length; i++)
        {
            var name = names[i];
            var prefix = TypePrefix(name);
            if (!groupIds.TryGetValue(prefix, out var groupId))
            {
                groupId = $"grp-{prefix}";
                groupIds[prefix] = groupId;
                list.Add(new BlazorResourceTimelineResource
                {
                    Id = groupId,
                    Name = $"{prefix}s",
                    ParentId = rootId
                });
            }

            list.Add(new BlazorResourceTimelineResource
            {
                Id = $"res-{i + 1}",
                Name = name,
                ParentId = groupId
            });
        }

        return list;
    }

    // Type prefix of a resource name (everything before the trailing "-NN"),
    // e.g. "Server-07" -> "Server", "Load-Balancer-01" -> "Load-Balancer".
    private static string TypePrefix(string name)
    {
        var dash = name.LastIndexOf('-');
        return dash > 0 ? name[..dash] : name;
    }

    /// <summary>
    /// Builds a time range spanning <paramref name="days"/> calendar days. The reference
    /// day (defaults to today) is placed randomly near the middle of the period so the
    /// timeline extends both into the past and the future.
    /// </summary>
    public static (DateTimeOffset StartDate, DateTimeOffset EndDate) GenerateTimeRange(int days, DateTime? referenceDate = null, int? seed = null)
    {
        if (days < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(days), "Must be at least 1.");
        }

        var today = (referenceDate ?? DateTime.Now).Date;
        var random = seed.HasValue ? new Random(seed.Value) : new Random();

        // Place "today" randomly within the second week of the span (day indices
        // 7..13). Clamp to the available range so short spans still work.
        var weekStart = Math.Min(7, days - 1);
        var weekEnd = Math.Min(13, days - 1);
        var todayIndex = weekStart <= weekEnd
            ? random.Next(weekStart, weekEnd + 1)
            : days - 1;

        var start = today.AddDays(-todayIndex);
        var end = start.AddDays(days - 1)
            .AddHours(23).AddMinutes(59).AddSeconds(59).AddMilliseconds(999);

        return (new DateTimeOffset(start), new DateTimeOffset(end));
    }

    /// <summary>
    /// Distributes allocation bars for every resource across the time range,
    /// keeping a minimum gap between bars so the layout stays readable.
    /// </summary>
    public static List<BlazorResourceTimelineAllocation> GenerateAllocations(
        List<BlazorResourceTimelineResource> resources,
        DateTimeOffset startDate,
        DateTimeOffset endDate,
        int minAllocationsPerDay = 3,
        int maxAllocationsPerDay = 8,
        long minDuration = 30 * 60 * 1000,
        long maxDuration = 4 * 60 * 60 * 1000,
        long minGap = 15 * 60 * 1000,
        int? seed = null)
    {
        var allocations = new List<BlazorResourceTimelineAllocation>();
        var random = seed.HasValue ? new Random(seed.Value) : new Random();
        var startMs = startDate.ToUnixTimeMilliseconds();
        var endMs = endDate.ToUnixTimeMilliseconds();
        var timeSpan = endMs - startMs;
        var days = (int)Math.Ceiling(timeSpan / (double)OneDayMs);
        var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var parentIds = ParentIds(resources);

        foreach (var resource in resources)
        {
            if (parentIds.Contains(resource.Id)) continue; // skip group/root rows

            AddAllocationsForResource(
                allocations, resource, startMs, endMs, timeSpan, days, nowMs, random,
                minAllocationsPerDay, maxAllocationsPerDay, minDuration, maxDuration, minGap);
        }

        return allocations.OrderBy(c => c.StartTime).ToList();
    }

    // Ids of resources that have at least one child (group/root rows), so the
    // allocation generators can skip them.
    private static HashSet<string> ParentIds(IEnumerable<BlazorResourceTimelineResource> resources) =>
        resources.Where(r => r.ParentId != null)
            .Select(r => r.ParentId!)
            .ToHashSet();

    /// <summary>
    /// Asynchronous, cooperative variant of <see cref="GenerateAllocations"/>. It yields to
    /// the UI thread between resources so a single-threaded host (Blazor WebAssembly) stays
    /// responsive, and observes <paramref name="cancellationToken"/> so an in-flight run can
    /// be abandoned the moment a newer request arrives.
    /// </summary>
    public static async Task<List<BlazorResourceTimelineAllocation>> GenerateAllocationsAsync(
        List<BlazorResourceTimelineResource> resources,
        DateTimeOffset startDate,
        DateTimeOffset endDate,
        CancellationToken cancellationToken = default,
        int minAllocationsPerDay = 3,
        int maxAllocationsPerDay = 8,
        long minDuration = 30 * 60 * 1000,
        long maxDuration = 4 * 60 * 60 * 1000,
        long minGap = 15 * 60 * 1000,
        int? seed = null)
    {
        var allocations = new List<BlazorResourceTimelineAllocation>();
        var random = seed.HasValue ? new Random(seed.Value) : new Random();
        var startMs = startDate.ToUnixTimeMilliseconds();
        var endMs = endDate.ToUnixTimeMilliseconds();
        var timeSpan = endMs - startMs;
        var days = (int)Math.Ceiling(timeSpan / (double)OneDayMs);
        var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var parentIds = ParentIds(resources);

        foreach (var resource in resources)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (parentIds.Contains(resource.Id)) continue; // skip group/root rows

            AddAllocationsForResource(
                allocations, resource, startMs, endMs, timeSpan, days, nowMs, random,
                minAllocationsPerDay, maxAllocationsPerDay, minDuration, maxDuration, minGap);

            // Hand control back to the event loop so pending UI work (loading
            // indicator, a new "Days" selection) can run between resources.
            await Task.Yield();
        }

        cancellationToken.ThrowIfCancellationRequested();
        return allocations.OrderBy(c => c.StartTime).ToList();
    }

    // Generates and appends the allocation bars for a single resource. Shared by the
    // synchronous and asynchronous generation paths to keep their behavior identical.
    private static void AddAllocationsForResource(
        List<BlazorResourceTimelineAllocation> allocations,
        BlazorResourceTimelineResource resource,
        long startMs,
        long endMs,
        long timeSpan,
        int days,
        long nowMs,
        Random random,
        int minAllocationsPerDay,
        int maxAllocationsPerDay,
        long minDuration,
        long maxDuration,
        long minGap)
    {
        var (abbrev, _) = GetResourceTypeInfo(resource.Name);
        var resourceNum = ExtractNumber(resource.Name);

        var allocationsPerDay = minAllocationsPerDay +
            random.Next(maxAllocationsPerDay - minAllocationsPerDay + 1);
        var totalAllocations = allocationsPerDay * days;
        if (totalAllocations <= 0) return;

        var avgDuration = (minDuration + maxDuration) / 2.0;
        var slotSize = timeSpan / (double)totalAllocations;
        var maxSlotUsage = Math.Min(slotSize * 0.7, avgDuration);
        var lastEndTime = startMs;

        for (var i = 0; i < totalAllocations; i++)
        {
            var slotStart = (long)(startMs + i * slotSize);
            var slotEnd = (long)(slotStart + slotSize);
            var minStart = Math.Max(slotStart, lastEndTime + minGap);
            var maxStart = Math.Min(slotEnd - minDuration - minGap, endMs - minDuration);

            if (maxStart <= minStart) continue;

            var duration = (long)(minDuration + random.NextDouble() *
                Math.Min(maxDuration - minDuration, maxSlotUsage - minDuration));
            var startTime = (long)(minStart + random.NextDouble() *
                Math.Max(0, maxStart - minStart - duration));
            var endTime = startTime + duration;

            if (endTime > endMs) continue;

            // Color by position relative to "now": green in the past, blue
            // in the future. A bar straddling now is treated as past.
            var isPast = startTime < nowMs;
            var color = isPast ? PastColor : FutureColor;

            var allocation = new BlazorResourceTimelineAllocation
            {
                Id = $"cons-{resource.Id}-{i}",
                ResourceId = resource.Id,
                StartTime = DateTimeOffset.FromUnixTimeMilliseconds(startTime),
                EndTime = DateTimeOffset.FromUnixTimeMilliseconds(endTime),
                Color = color,
                // Short, abbreviated labels around each bar:
                //   above -> resource abbreviation + number     (e.g. "SRV01")
                //   below -> duration                           (e.g. "2h15m")
                //   start -> start time                         (e.g. "08:30")
                //   end   -> end time                           (e.g. "10:45")
                TextAbove = $"{abbrev}{resourceNum}",
                TextBelow = AbbreviateDuration(endTime - startTime),
                TextStart = AbbreviateTime(startTime),
                TextEnd = AbbreviateTime(endTime)
            };

            // On some past bars, attach red delay bars at both ends to
            // showcase the edge-bar customization feature.
            if (isPast && random.NextDouble() < DelayProbability)
            {
                var startDelay = (long)(minDuration * (0.3 + random.NextDouble() * 0.7));
                var endDelay = (long)(minDuration * (0.3 + random.NextDouble() * 0.7));
                allocation.StartBar = new BlazorResourceTimelineEdgeBar { Duration = TimeSpan.FromMilliseconds(startDelay), Color = DelayColor };
                allocation.EndBar = new BlazorResourceTimelineEdgeBar { Duration = TimeSpan.FromMilliseconds(endDelay), Color = DelayColor };
            }

            // Randomly decorate some bars with one or two icons at random
            // positions to showcase the custom-icon feature.
            if (random.NextDouble() < IconProbability)
            {
                var iconCount = random.Next(1, 3); // 1 or 2 icons
                var icons = new List<BlazorResourceTimelineBarIcon>(iconCount);
                for (var k = 0; k < iconCount; k++)
                {
                    icons.Add(new BlazorResourceTimelineBarIcon
                    {
                        Source = IconSources[random.Next(IconSources.Length)],
                        Position = IconPositions[random.Next(IconPositions.Length)],
                        Size = 14 + random.Next(5) // 14..18 px
                    });
                }
                allocation.Icons = icons;
            }

            allocations.Add(allocation);
            lastEndTime = endTime;
        }
    }

    // Maps a resource name to its abbreviation and color, matching on the
    // type prefix (everything before the trailing "-NN").
    private static (string Abbrev, string Color) GetResourceTypeInfo(string resourceName)
    {
        foreach (var (prefix, info) in ResourceTypeInfo)
        {
            if (resourceName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                return info;
            }
        }
        // Fallback: first three letters, neutral color.
        var abbrev = resourceName.Length >= 3
            ? resourceName[..3].ToUpperInvariant()
            : resourceName.ToUpperInvariant();
        return (abbrev, FallbackColor);
    }

    // Returns the trailing numeric part of a name (e.g. "Server-07" -> "07").
    private static string ExtractNumber(string resourceName)
    {
        var dash = resourceName.LastIndexOf('-');
        return dash >= 0 && dash < resourceName.Length - 1
            ? resourceName[(dash + 1)..]
            : string.Empty;
    }

    // Compact duration, e.g. "2h15m" or "45m".
    private static string AbbreviateDuration(long ms)
    {
        var span = TimeSpan.FromMilliseconds(ms);
        return span.TotalHours >= 1
            ? $"{(int)span.TotalHours}h{span.Minutes:D2}m"
            : $"{span.Minutes}m";
    }

    // Compact 24-hour time, e.g. "08:30".
    private static string AbbreviateTime(long unixMs) =>
        DateTimeOffset.FromUnixTimeMilliseconds(unixMs).LocalDateTime.ToString("HH:mm");

    // Wraps raw SVG markup as an inline, URL-encoded data URI usable as an
    // image source by the renderer.
    private static string SvgDataUri(string svg) =>
        "data:image/svg+xml," + Uri.EscapeDataString(svg);

    /// <summary>Generates a complete <see cref="BlazorResourceTimelineConfig"/> bundle in one call.</summary>
    public static BlazorResourceTimelineConfig GenerateSampleData(
        int days = 100,
        string[]? resourceNames = null,
        int? seed = null)
    {
        var resources = GenerateResources(resourceNames);
        var (startDate, endDate) = GenerateTimeRange(days, seed: seed);
        var allocations = GenerateAllocations(resources, startDate, endDate, seed: seed);

        return new BlazorResourceTimelineConfig
        {
            Resources = resources,
            StartDate = startDate,
            EndDate = endDate,
            Allocations = allocations
        };
    }

    /// <summary>
    /// Asynchronous, cancellable variant of <see cref="GenerateSampleData"/>. It yields to the
    /// UI thread while building allocations so the host stays responsive during a heavy run,
    /// and throws <see cref="OperationCanceledException"/> if <paramref name="cancellationToken"/>
    /// is signalled (e.g. the user picks a different number of days mid-run).
    /// </summary>
    public static async Task<BlazorResourceTimelineConfig> GenerateSampleDataAsync(
        int days = 100,
        CancellationToken cancellationToken = default,
        string[]? resourceNames = null,
        int? seed = null)
    {
        var resources = GenerateResources(resourceNames);
        var (startDate, endDate) = GenerateTimeRange(days, seed: seed);
        var allocations = await GenerateAllocationsAsync(
            resources, startDate, endDate, cancellationToken, seed: seed);

        return new BlazorResourceTimelineConfig
        {
            Resources = resources,
            StartDate = startDate,
            EndDate = endDate,
            Allocations = allocations
        };
    }
}
