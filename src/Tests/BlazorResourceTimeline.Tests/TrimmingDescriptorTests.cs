using System.Reflection;
using System.Xml.Linq;
using TimelineComponent = global::BlazorResourceTimeline.BlazorResourceTimeline;

namespace BlazorResourceTimeline.Tests;

/// <summary>
/// The library is marked <c>&lt;IsTrimmable&gt;</c>, so a trimmed app (Blazor
/// WebAssembly trims on publish) removes members it cannot see used. The interop
/// models are only ever touched by reflection - System.Text.Json walks them when
/// Blazor marshals them to and from the rendering engine - so they are rooted
/// explicitly in the embedded <c>ILLink.Descriptors.xml</c>.
/// <para>
/// Omitting a type there fails silently at runtime: the trimmer drops the
/// properties nothing assigns from C#, so they are never serialized and the
/// renderer quietly falls back to its defaults. Measured on a trimmed publish
/// before the descriptors existed, <see cref="BlazorResourceTimelineOptions"/>
/// kept 6 of its 36 properties. These tests turn that silent breakage into a
/// failing build.
/// </para>
/// </summary>
public class TrimmingDescriptorTests
{
    private static readonly Assembly Library = typeof(BlazorResourceTimelineAllocation).Assembly;

    /// <summary>
    /// The types handed to (or received from) System.Text.Json at the interop
    /// boundary. Types reachable from these by property are discovered
    /// automatically, so only a brand new root needs adding here.
    /// </summary>
    private static readonly Type[] InteropRoots =
    [
        typeof(BlazorResourceTimelineOptions),                 // setOptions / createTimeline
        typeof(BlazorResourceTimelineResource),                // setData / beginData / beginWindowed
        typeof(BlazorResourceTimelineAllocation),              // setData / appendAllocations
        typeof(BlazorResourceTimelineLayout),                  // getLayout (JS -> .NET)
        typeof(TimelineComponent).GetNestedType("ResourceRow")!, // OnResourceRowsChanged (JS -> .NET)
    ];

    [Fact]
    public void EveryTypeReachableFromTheInteropBoundaryIsRooted()
    {
        var rooted = RootedTypeNames();

        var missing = ReachableLibraryTypes()
            .Select(DescriptorName)
            .Where(name => !rooted.Contains(name))
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToList();

        Assert.True(
            missing.Count == 0,
            "These types cross the JS interop boundary but are not rooted in " +
            "src/BlazorResourceTimeline/ILLink.Descriptors.xml, so a trimmed app would " +
            "silently drop their properties:" + Environment.NewLine +
            string.Join(Environment.NewLine, missing.Select(n => $"  <type fullname=\"{n}\" preserve=\"all\" />")));
    }

    [Fact]
    public void EveryRootedTypeStillExists()
    {
        // A typo'd or renamed fullname preserves nothing, and the trimmer does not
        // complain, so the descriptor would look correct while doing nothing.
        var unresolved = RootedTypeNames()
            .Where(name => Library.GetType(name.Replace('/', '+')) is null)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToList();

        Assert.True(
            unresolved.Count == 0,
            "These names in ILLink.Descriptors.xml do not resolve to a type in the library " +
            "(renamed or misspelled), so they root nothing:" + Environment.NewLine +
            string.Join(Environment.NewLine, unresolved.Select(n => "  " + n)));
    }

    [Fact]
    public void DescriptorsTargetThisAssembly()
    {
        // A fullname pointing at another assembly roots nothing here.
        var targeted = Assert.Single(Descriptors().Root!.Elements("assembly"));

        Assert.Equal(Library.GetName().Name, targeted.Attribute("fullname")?.Value);
    }

    /// <summary>Loads the descriptor file as the trimmer sees it - embedded in the assembly.</summary>
    private static XDocument Descriptors()
    {
        using var stream = Library.GetManifestResourceStream("ILLink.Descriptors.xml");

        Assert.NotNull(stream); // wrong LogicalName in the csproj: the trimmer would not find it either
        return XDocument.Load(stream);
    }

    private static HashSet<string> RootedTypeNames() =>
        Descriptors()
            .Descendants("type")
            .Select(t => (string?)t.Attribute("fullname"))
            .Where(n => !string.IsNullOrEmpty(n))
            .Select(n => n!)
            .ToHashSet(StringComparer.Ordinal);

    /// <summary>
    /// Walks the public property graph from <see cref="InteropRoots"/>, keeping the
    /// types declared by the library itself. Mirrors what a reflection-based
    /// serializer touches, so new nested models are caught without updating a list.
    /// </summary>
    private static HashSet<Type> ReachableLibraryTypes()
    {
        var found = new HashSet<Type>();
        var queue = new Queue<Type>(InteropRoots);

        while (queue.Count > 0)
        {
            foreach (var type in Unwrap(queue.Dequeue()))
            {
                // Types from other assemblies (string, DateTimeOffset, ...) are the
                // framework's problem; it roots its own serializable surface.
                if (type.Assembly != Library || !found.Add(type) || type.IsEnum)
                {
                    continue;
                }

                foreach (var property in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
                {
                    queue.Enqueue(property.PropertyType);
                }
            }
        }

        return found;
    }

    /// <summary>
    /// Reduces a property type to the types actually serialized: unwraps
    /// nullables, arrays and collection/dictionary element types.
    /// </summary>
    private static IEnumerable<Type> Unwrap(Type type)
    {
        if (type.IsArray)
        {
            return Unwrap(type.GetElementType()!);
        }

        if (type.IsGenericType)
        {
            var underlying = Nullable.GetUnderlyingType(type);
            return underlying is not null
                ? Unwrap(underlying)
                : type.GetGenericArguments().SelectMany(Unwrap);
        }

        return [type];
    }

    /// <summary>
    /// Formats a type the way the trimmer's descriptor XML does - nested types use
    /// a <c>/</c> separator where reflection uses <c>+</c>.
    /// </summary>
    private static string DescriptorName(Type type) => type.FullName!.Replace('+', '/');
}
