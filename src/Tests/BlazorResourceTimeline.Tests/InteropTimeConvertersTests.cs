using System.Text.Json;
using System.Text.Json.Serialization;
using BlazorResourceTimeline.Json;

namespace BlazorResourceTimeline.Tests;

public class InteropTimeConvertersTests
{
    private static JsonSerializerOptions Options(JsonConverter converter) =>
        new() { Converters = { converter } };

    [Fact]
    public void DateTimeOffset_WritesUnixMillisecondsNumber()
    {
        var options = Options(new UnixTimeMillisecondsJsonConverter());
        var value = DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_000_123);

        var json = JsonSerializer.Serialize(value, options);

        // Must be a bare JSON number (the renderer reads alloc.startTime as ms).
        Assert.Equal("1700000000123", json);
    }

    [Theory]
    [InlineData(0L)]
    [InlineData(1_700_000_000_123L)]
    [InlineData(-62_135_596_800_000L)]
    public void DateTimeOffset_RoundTrips(long unixMs)
    {
        var options = Options(new UnixTimeMillisecondsJsonConverter());
        var original = DateTimeOffset.FromUnixTimeMilliseconds(unixMs);

        var json = JsonSerializer.Serialize(original, options);
        var restored = JsonSerializer.Deserialize<DateTimeOffset>(json, options);

        Assert.Equal(original, restored);
    }

    [Fact]
    public void DateTimeOffset_ReadsFromStringNumber()
    {
        var options = Options(new UnixTimeMillisecondsJsonConverter());

        var restored = JsonSerializer.Deserialize<DateTimeOffset>("\"1700000000123\"", options);

        Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_000_123), restored);
    }

    [Fact]
    public void TimeSpan_WritesMillisecondsNumber()
    {
        var options = Options(new MillisecondsTimeSpanJsonConverter());

        var json = JsonSerializer.Serialize(TimeSpan.FromMinutes(90), options);

        Assert.Equal("5400000", json);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1500)]
    [InlineData(3_600_000)]
    public void TimeSpan_RoundTrips(int ms)
    {
        var options = Options(new MillisecondsTimeSpanJsonConverter());
        var original = TimeSpan.FromMilliseconds(ms);

        var json = JsonSerializer.Serialize(original, options);
        var restored = JsonSerializer.Deserialize<TimeSpan>(json, options);

        Assert.Equal(original, restored);
    }
}
