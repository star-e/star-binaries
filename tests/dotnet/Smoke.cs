using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;

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
        public nint Log;
        public nint Profile;
    }

    [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvCdecl) })]
    public static int Run(nint data, int size)
    {
        nint log = 0;
        // Exceptions must never unwind across the C ABI.
        try
        {
            if (data == 0 || size != sizeof(Request))
                throw new ArgumentException("Invalid native request");
            var request = *(Request*)data;
            log = request.Log;
            var expectedCoreLib = Marshal.PtrToStringUTF8(request.CoreLibPath)!;
            var version = Marshal.PtrToStringUTF8(request.Version)!;
            var revision = Marshal.PtrToStringUTF8(request.Revision)!;
            var coreLib = typeof(object).Assembly;
            if (!string.Equals(Path.GetFullPath(coreLib.Location), Path.GetFullPath(expectedCoreLib),
                    OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
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
            var handle = GCHandle.Alloc(bytes, GCHandleType.Pinned);
            try
            {
                if (Marshal.ReadByte(handle.AddrOfPinnedObject(), bytes.Length - 1) != 42)
                    throw new InvalidOperationException("Pinned memory read failed");
            }
            finally { handle.Free(); }
            Features.Check(Path.GetDirectoryName(coreLib.Location)!,
                Marshal.PtrToStringUTF8(request.Profile)!);
            WriteLog(log, $"CoreLib: {coreLib.Location}");
            WriteLog(log, $"Runtime: {RuntimeInformation.FrameworkDescription}; source: {information}");
            WriteLog(log, "STAR_DOTNET_BASE_FEATURES_PASSED");
            return 0;
        }
        catch (Exception error)
        {
            WriteLog(log, error.ToString());
            return 1;
        }
    }

    private static void WriteLog(nint log, string message)
    {
        if (log == 0) return;
        var bytes = Encoding.UTF8.GetBytes(message);
        fixed (byte* pointer = bytes)
            ((delegate* unmanaged[Cdecl]<byte*, int, void>)log)(pointer, bytes.Length);
    }
}
