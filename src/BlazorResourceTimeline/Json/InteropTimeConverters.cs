using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace BlazorResourceTimeline.Json;

/// <summary>
/// Serializes a <see cref="DateTimeOffset"/> as Unix time in milliseconds (a
/// JSON number). The public model exposes <see cref="DateTimeOffset"/> for
/// ergonomics while the canvas renderer works in milliseconds; this converts at
/// the interop boundary without an intermediate projection.
/// </summary>
public sealed class UnixTimeMillisecondsJsonConverter : JsonConverter<DateTimeOffset>
{
    /// <inheritdoc />
    public override DateTimeOffset Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        var ms = reader.TokenType == JsonTokenType.String
            ? long.Parse(reader.GetString()!, CultureInfo.InvariantCulture)
            : reader.GetInt64();
        return DateTimeOffset.FromUnixTimeMilliseconds(ms);
    }

    /// <inheritdoc />
    public override void Write(Utf8JsonWriter writer, DateTimeOffset value, JsonSerializerOptions options)
    {
        writer.WriteNumberValue(value.ToUnixTimeMilliseconds());
    }
}

/// <summary>
/// Serializes a <see cref="TimeSpan"/> as a whole number of milliseconds (a JSON
/// number), matching the duration representation the canvas renderer expects.
/// </summary>
public sealed class MillisecondsTimeSpanJsonConverter : JsonConverter<TimeSpan>
{
    /// <inheritdoc />
    public override TimeSpan Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        var ms = reader.TokenType == JsonTokenType.String
            ? long.Parse(reader.GetString()!, CultureInfo.InvariantCulture)
            : reader.GetInt64();
        return TimeSpan.FromMilliseconds(ms);
    }

    /// <inheritdoc />
    public override void Write(Utf8JsonWriter writer, TimeSpan value, JsonSerializerOptions options)
    {
        writer.WriteNumberValue((long)value.TotalMilliseconds);
    }
}
