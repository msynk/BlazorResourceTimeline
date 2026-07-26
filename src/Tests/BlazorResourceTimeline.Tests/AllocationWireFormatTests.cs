using System.Text.Json;
using BlazorResourceTimeline.Models;

namespace BlazorResourceTimeline.Tests;

/// <summary>
/// Locks the JSON shape the canvas renderer relies on. Blazor's JS interop
/// serializes with <see cref="JsonSerializerDefaults.Web"/> (camelCase, case
/// insensitive), so these tests mirror that to catch any accidental change to
/// the wire contract (property names or the numeric time representation).
/// </summary>
public class AllocationWireFormatTests
{
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    [Fact]
    public void Allocation_SerializesTimesAsUnixMillisecondNumbers()
    {
        var alloc = new BlazorResourceTimelineAllocation
        {
            Id = "a1",
            ResourceId = "r1",
            StartTime = DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_000_000),
            EndTime = DateTimeOffset.FromUnixTimeMilliseconds(1_700_003_600_000),
        };

        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(alloc, Web));
        var root = doc.RootElement;

        Assert.Equal(JsonValueKind.Number, root.GetProperty("startTime").ValueKind);
        Assert.Equal(1_700_000_000_000, root.GetProperty("startTime").GetInt64());
        Assert.Equal(1_700_003_600_000, root.GetProperty("endTime").GetInt64());
        Assert.Equal("a1", root.GetProperty("id").GetString());
        Assert.Equal("r1", root.GetProperty("resourceId").GetString());
    }

    [Fact]
    public void EdgeBar_SerializesDurationAsMillisecondNumber()
    {
        var alloc = new BlazorResourceTimelineAllocation
        {
            Id = "a1",
            ResourceId = "r1",
            StartTime = DateTimeOffset.FromUnixTimeMilliseconds(0),
            EndTime = DateTimeOffset.FromUnixTimeMilliseconds(1000),
            StartBar = new BlazorResourceTimelineEdgeBar { Duration = TimeSpan.FromMinutes(15), Color = "red" },
        };

        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(alloc, Web));
        var startBar = doc.RootElement.GetProperty("startBar");

        Assert.Equal(JsonValueKind.Number, startBar.GetProperty("duration").ValueKind);
        Assert.Equal(900_000, startBar.GetProperty("duration").GetInt64());
        Assert.Equal("red", startBar.GetProperty("color").GetString());
    }

    [Fact]
    public void Options_SerializeEditingKeysWithExpectedNames()
    {
        var options = new BlazorResourceTimelineOptions
        {
            Editable = true,
            EditSnapMinutes = 30,
            EditResizeHandlePx = 8,
            EditMinDurationMinutes = 10,
            AllowResourceChange = false,
        };

        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(options, Web));
        var root = doc.RootElement;

        // The renderer reads these exact camelCased keys off its config object.
        Assert.True(root.GetProperty("editable").GetBoolean());
        Assert.Equal(30, root.GetProperty("editSnapMinutes").GetInt32());
        Assert.Equal(8, root.GetProperty("editResizeHandlePx").GetInt32());
        Assert.Equal(10, root.GetProperty("editMinDurationMinutes").GetInt32());
        Assert.False(root.GetProperty("allowResourceChange").GetBoolean());
    }

    [Fact]
    public void Options_OmitEditingKeysWhenNull()
    {
        var options = new BlazorResourceTimelineOptions();

        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(options, Web));
        var root = doc.RootElement;

        Assert.False(root.TryGetProperty("editable", out _));
        Assert.False(root.TryGetProperty("editSnapMinutes", out _));
        Assert.False(root.TryGetProperty("allowResourceChange", out _));
    }

    [Fact]
    public void Options_SerializeTooltipKeysWithExpectedNames()
    {
        var options = new BlazorResourceTimelineOptions
        {
            ShowTooltips = false,
            TooltipDelayMs = 500,
            Colors = new() { TooltipBg = "#000", TooltipText = "#fff", Focus = "#f00" },
        };

        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(options, Web));
        var root = doc.RootElement;

        Assert.False(root.GetProperty("showTooltips").GetBoolean());
        Assert.Equal(500, root.GetProperty("tooltipDelayMs").GetInt32());
        var colors = root.GetProperty("colors");
        Assert.Equal("#000", colors.GetProperty("tooltipBg").GetString());
        Assert.Equal("#fff", colors.GetProperty("tooltipText").GetString());
        Assert.Equal("#f00", colors.GetProperty("focus").GetString());
    }

    [Fact]
    public void Options_SerializeWindowingKeysWithExpectedNames()
    {
        var options = new BlazorResourceTimelineOptions
        {
            WindowBufferFactor = 2,
            WindowRefetchThreshold = 0.5,
            WindowDebounceMs = 100,
        };

        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(options, Web));
        var root = doc.RootElement;

        Assert.Equal(2, root.GetProperty("windowBufferFactor").GetDouble());
        Assert.Equal(0.5, root.GetProperty("windowRefetchThreshold").GetDouble());
        Assert.Equal(100, root.GetProperty("windowDebounceMs").GetInt32());
    }

    [Fact]
    public void Resource_SerializesHierarchyKeysWithExpectedNames()
    {
        var resource = new BlazorResourceTimelineResource
        {
            Id = "grp-1",
            Name = "Servers",
            ParentId = "root",
            Collapsed = true,
        };

        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(resource, Web));
        var root = doc.RootElement;

        Assert.Equal("root", root.GetProperty("parentId").GetString());
        Assert.True(root.GetProperty("collapsed").GetBoolean());
    }

    [Fact]
    public void Resource_OmitsParentIdWhenNull()
    {
        var resource = new BlazorResourceTimelineResource { Id = "r1", Name = "Server-01" };

        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(resource, Web));

        Assert.False(doc.RootElement.TryGetProperty("parentId", out _));
    }

    [Fact]
    public void Options_SerializeLocaleWithExpectedName()
    {
        var options = new BlazorResourceTimelineOptions { Locale = "de-DE" };

        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(options, Web));

        Assert.Equal("de-DE", doc.RootElement.GetProperty("locale").GetString());
    }

    [Fact]
    public void Allocation_SerializesTooltipWhenSet()
    {
        var alloc = new BlazorResourceTimelineAllocation
        {
            Id = "a1",
            ResourceId = "r1",
            StartTime = DateTimeOffset.FromUnixTimeMilliseconds(0),
            EndTime = DateTimeOffset.FromUnixTimeMilliseconds(1000),
            Tooltip = "LH441\nGate A1",
        };

        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(alloc, Web));
        Assert.Equal("LH441\nGate A1", doc.RootElement.GetProperty("tooltip").GetString());
    }

    [Fact]
    public void Allocation_RoundTripsThroughWebSerializer()
    {
        var alloc = new BlazorResourceTimelineAllocation
        {
            Id = "a1",
            ResourceId = "r1",
            StartTime = DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_000_000),
            EndTime = DateTimeOffset.FromUnixTimeMilliseconds(1_700_003_600_000),
            EndBar = new BlazorResourceTimelineEdgeBar { Duration = TimeSpan.FromMinutes(5) },
        };

        var json = JsonSerializer.Serialize(alloc, Web);
        var restored = JsonSerializer.Deserialize<BlazorResourceTimelineAllocation>(json, Web)!;

        Assert.Equal(alloc.StartTime, restored.StartTime);
        Assert.Equal(alloc.EndTime, restored.EndTime);
        Assert.Equal(alloc.EndBar!.Duration, restored.EndBar!.Duration);
    }
}
