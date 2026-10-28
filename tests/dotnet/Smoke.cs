using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace Star.DotNet;

public static unsafe class Smoke
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Request
    {
        public nint Callback;
        public nint CoreLibPath;
        public nint Version;
        public nint Revision;
    }

    [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvCdecl) })]
    public static int Run(nint data, int size)
    {
        // Exceptions must never unwind across the C ABI.
        try
        {
            if (data == 0 || size != sizeof(Request))
                throw new ArgumentException("Invalid native request");
            var request = *(Request*)data;
            var expectedCoreLib = Marshal.PtrToStringUni(request.CoreLibPath)!;
            var version = Marshal.PtrToStringUni(request.Version)!;
            var revision = Marshal.PtrToStringUni(request.Revision)!;
            var coreLib = typeof(object).Assembly;
            if (!string.Equals(Path.GetFullPath(coreLib.Location), Path.GetFullPath(expectedCoreLib),
                    StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"Wrong CoreLib: {coreLib.Location}");
            var information = coreLib.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "";
            if (!information.StartsWith(version + "+", StringComparison.Ordinal) ||
                !information.Contains(revision, StringComparison.Ordinal))
                throw new InvalidOperationException($"Wrong CoreLib build: {information}");

            var callback = (delegate* unmanaged[Cdecl]<int, int>)request.Callback;
            if (callback == null || callback(41) != 42)
                throw new InvalidOperationException("Native callback failed");
            // Exercise allocation and GC as well as the managed entry point.
            var bytes = new byte[1024 * 1024];
            bytes[^1] = 42;
            GC.Collect();
            GC.WaitForPendingFinalizers();
            if (bytes[^1] != 42)
                throw new InvalidOperationException("Managed allocation failed");
            Console.WriteLine($"CoreLib: {coreLib.Location}");
            Console.WriteLine($"Runtime: {RuntimeInformation.FrameworkDescription}; source: {information}");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 1;
        }
    }
}
