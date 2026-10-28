using System.Collections.Concurrent;
using System.Collections.ObjectModel;
using System.Globalization;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Runtime.Loader;

namespace Star.DotNet;

internal static class Features
{
    internal static void Check(string framework, string profile)
    {
        var items = new List<int> { 20, 22 };
        var lookup = new Dictionary<string, int> { ["answer"] = items[0] + items[1] };
        var concurrent = new ConcurrentDictionary<string, int>();
        concurrent["answer"] = lookup["answer"];
        var observable = new ObservableCollection<int>();
        var notifications = 0;
        observable.CollectionChanged += (_, _) => ++notifications;
        observable.Add(concurrent["answer"]);
        Require(observable[0] == 42 && notifications == 1, "Collections failed");
        using (var memory = System.Buffers.MemoryPool<byte>.Shared.Rent(16))
        {
            memory.Memory.Span[0] = 42;
            Require(memory.Memory.Span[0] == 42, "MemoryPool failed");
        }
        Require(CultureInfo.GetCultureInfo("en-US").TextInfo.ToUpper("test") == "TEST" &&
            "e\u0301".Normalize() == "\u00e9", "Globalization failed");

        CheckTasks().GetAwaiter().GetResult();
        using (var signal = new ManualResetEventSlim())
        {
            var thread = new Thread(() => signal.Set());
            thread.Start();
            Require(signal.Wait(TimeSpan.FromSeconds(10)), "Thread did not signal");
            thread.Join();
        }
        var library = NativeLibrary.Load(Path.Combine(framework,
            OperatingSystem.IsWindows() ? "coreclr.dll" : "libcoreclr.dylib"));
        try { Require(NativeLibrary.TryGetExport(library, "coreclr_initialize", out _), "Native export missing"); }
        finally { NativeLibrary.Free(library); }

        var plugin = Path.Combine(Path.GetDirectoryName(typeof(Features).Assembly.Location)!,
            "plugin", "Star.DotNet.Plugin.dll");
        var weak = RunPlugin(plugin);
        for (var i = 0; weak.IsAlive && i < 10; ++i)
        {
            GC.Collect();
            GC.WaitForPendingFinalizers();
        }
        Require(!weak.IsAlive, "Plugin context did not unload");
        ExpectMissing("Star.DotNet.DoesNotExist");
        if (profile == "base")
        {
            ExpectMissing("System.Xml.ReaderWriter");
            ExpectMissing("System.Console");
        }
        // Runtime assemblies must come from the selected package, not the compiler SDK.
        foreach (var assembly in AssemblyLoadContext.Default.Assemblies)
        {
            if (assembly.GetName().Name!.StartsWith("System.", StringComparison.Ordinal))
                Require(Path.GetDirectoryName(assembly.Location) == framework,
                    $"Framework assembly escaped package: {assembly.Location}");
        }
    }

    private static async Task CheckTasks()
    {
        var answer = await Task.Run(async () => { await Task.Delay(1); return 42; });
        Require(answer == await new ValueTask<int>(42), "Task/ValueTask failed");
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        try { await Task.Delay(Timeout.Infinite, cancellation.Token); throw new InvalidOperationException("Cancellation failed"); }
        catch (OperationCanceledException) { }
        var fired = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var timer = new Timer(_ => fired.TrySetResult(true), null, 1, Timeout.Infinite);
        await fired.Task.WaitAsync(TimeSpan.FromSeconds(10));
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static WeakReference RunPlugin(string path)
    {
        var context = new AssemblyLoadContext("StarPlugin", isCollectible: true);
        var resolver = new AssemblyDependencyResolver(path);
        context.Resolving += (owner, name) =>
        {
            var dependency = resolver.ResolveAssemblyToPath(name);
            return dependency is null ? null : owner.LoadFromAssemblyPath(dependency);
        };
        var weak = new WeakReference(context);
        try
        {
            var assembly = context.LoadFromAssemblyPath(path);
            var method = assembly.GetType("Star.DotNet.Plugin.Entry")!.GetMethod("Answer")!;
            Require((int)method.Invoke(null, null)! == 42, "Plugin/private dependency call failed");
        }
        finally { context.Unload(); }
        return weak;
    }

    private static void ExpectMissing(string name)
    {
        try { AssemblyLoadContext.Default.LoadFromAssemblyName(new AssemblyName(name)); }
        catch (FileNotFoundException) { return; }
        throw new InvalidOperationException($"Unexpected assembly resolved: {name}");
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
