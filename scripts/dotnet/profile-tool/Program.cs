using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

try
{
    if (args is ["pack", var profile, var source, var destination])
        PackageProfile(profile, source, destination);
    else if (args is ["check-app", var sdk, var applications])
        CheckApplications(sdk, applications);
    else
        throw new ArgumentException("Usage: pack <profile.json> <source-sdk> <new-sdk> | check-app <sdk> <assembly-directory>");
    return 0;
}
catch (Exception error)
{
    Console.Error.WriteLine(error.Message);
    return 1;
}

static JsonObject ReadObject(string path) =>
    JsonNode.Parse(File.ReadAllText(path))!.AsObject();

static string Text(JsonNode node, string key) => node[key]!.GetValue<string>();

static string[] Strings(JsonNode node) =>
    node.AsArray().Select(value => value!.GetValue<string>()).ToArray();

static void Require(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

static void WriteJson(string path, object value) =>
    File.WriteAllText(path, JsonSerializer.Serialize(value, new JsonSerializerOptions { WriteIndented = true }) + "\n");

static void CheckName(string name)
{
    Require(Regex.IsMatch(name, @"\A[A-Za-z_][A-Za-z0-9_.-]*\z") && !name.Contains(".."),
        $"Invalid assembly or file name: {name}");
}

static (string Name, Version Version, (string Name, Version Version)[] References, string[] Imports) Inspect(string path)
{
    Require(File.Exists(path), $"Missing assembly: {path}");
    using var stream = File.OpenRead(path);
    using var pe = new PEReader(stream);
    var metadata = pe.GetMetadataReader();
    var definition = metadata.GetAssemblyDefinition();
    var references = metadata.AssemblyReferences.Select(handle =>
    {
        var reference = metadata.GetAssemblyReference(handle);
        return (metadata.GetString(reference.Name), reference.Version);
    }).ToArray();
    var imports = new SortedSet<string>(StringComparer.Ordinal);
    foreach (var handle in metadata.MethodDefinitions)
    {
        var import = metadata.GetMethodDefinition(handle).GetImport();
        if (!import.Module.IsNil)
            imports.Add(metadata.GetString(metadata.GetModuleReference(import.Module).Name));
    }
    return (metadata.GetString(definition.Name), definition.Version, references, imports.ToArray());
}

static string FrameworkDirectory(string sdk, JsonNode build) =>
    Path.Combine(sdk, "runtime", "shared", "Microsoft.NETCore.App", Text(build, "runtimeVersion"));

static void CopyFile(string source, string destination)
{
    Require(File.Exists(source), $"Missing package file: {source}");
    Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
    File.Copy(source, destination, overwrite: false);
    if (!OperatingSystem.IsWindows())
        File.SetUnixFileMode(destination, File.GetUnixFileMode(source));
}

static void PackageProfile(string profilePath, string source, string destination)
{
    source = Path.GetFullPath(source);
    destination = Path.GetFullPath(destination);
    Require(!Directory.Exists(destination) && !File.Exists(destination), "Destination must not already exist");
    var relative = Path.GetRelativePath(source, destination);
    Require(Path.IsPathRooted(relative) || relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal),
        "Destination must be outside the source SDK");
    var profile = ReadObject(profilePath);
    var buildPath = Path.Combine(source, "provenance", "build.json");
    var build = ReadObject(buildPath);
    Require(profile["schemaVersion"]!.GetValue<int>() == 1, "Unsupported profile schema");
    var profileName = Text(profile, "name");
    Require(Regex.IsMatch(profileName, @"\A[a-z][a-z0-9-]*\z") && profileName != "full", "Invalid profile name");
    Require(build["profile"] is null || Text(build, "profile") == "full", "Input must be a full SDK");
    Require(Text(profile, "sourceRevision") == Text(build, "sourceRevision"), "Profile revision differs from input SDK");
    var triplet = Text(build, "triplet");
    Require(Strings(profile["targets"]!).Contains(triplet), "Profile does not support this target");
    var policy = profile["policy"]!;
    Require(Text(policy, "selection") == "roots-and-transitive-dependencies" &&
        Text(policy, "excludedDependency") == "error" && !policy["trimManagedMembers"]!.GetValue<bool>() &&
        Text(policy, "globalization") == "upstream-default" &&
        Text(policy, "scriptDependencies") == "profile-or-explicit-application-dependency", "Unsupported profile policy");
    var roots = profile["managedRoots"]!.AsObject().SelectMany(group => Strings(group.Value!)).ToArray();
    Require(roots.Length > 0 && roots.Distinct(StringComparer.OrdinalIgnoreCase).Count() == roots.Length,
        "Empty or duplicate managed roots");
    var exclusions = Strings(profile["excludedManagedPatterns"]!).Select(pattern =>
        new Regex("\\A" + Regex.Escape(pattern).Replace("\\*", ".*") + "\\z", RegexOptions.IgnoreCase)).ToArray();
    var framework = FrameworkDirectory(source, build);
    var pending = new Queue<string>(roots);
    var selected = new SortedSet<string>(StringComparer.Ordinal);
    var imports = new SortedSet<string>(StringComparer.Ordinal);
    var references = new SortedDictionary<string, string[]>(StringComparer.Ordinal);
    while (pending.TryDequeue(out var name))
    {
        CheckName(name);
        if (!selected.Add(name)) continue;
        Require(!exclusions.Any(pattern => pattern.IsMatch(name)), $"Excluded dependency: {name}");
        var assembly = Inspect(Path.Combine(framework, name + ".dll"));
        Require(assembly.Name == name, $"Assembly identity differs from filename: {name}");
        references.Add(name, assembly.References.Select(reference => reference.Name).Order().ToArray());
        foreach (var reference in assembly.References) pending.Enqueue(reference.Name);
        imports.UnionWith(assembly.Imports);
    }
    Require(selected.Contains("System.Private.CoreLib"), "Profile must include CoreLib");

    var native = profile["nativeRoots"]![triplet]!;
    var nativeFiles = Strings(native["framework"]!);
    var hostfxr = Text(native, "hostfxr");
    var nethost = Text(native, "nethost");
    foreach (var name in nativeFiles.Append(hostfxr).Append(nethost)) CheckName(name);
    var managedFiles = selected.Select(name => name + ".dll").ToHashSet(StringComparer.Ordinal);
    Require(!nativeFiles.Any(managedFiles.Contains), "Managed/native file overlap");
    var deps = ReadObject(Path.Combine(framework, "Microsoft.NETCore.App.deps.json"));
    var target = deps["targets"]![Text(deps["runtimeTarget"]!, "name")]!.AsObject();
    // The pinned shared framework uses a single runtime package. Reject a changed
    // upstream layout instead of accidentally dropping package dependencies.
    Require(target.Count == 1, "Unsupported framework dependency layout");
    var packageName = target.Single().Key;
    var package = target.Single().Value!.AsObject();
    Require(package.All(pair => pair.Key is "runtime" or "native"), "Unsupported framework asset groups");
    foreach (var (group, files) in new[] { ("runtime", managedFiles), ("native", nativeFiles.ToHashSet(StringComparer.Ordinal)) })
    {
        var assets = package[group]!.AsObject();
        foreach (var file in files) Require(assets.ContainsKey(file), $"Asset missing from framework deps: {file}");
        foreach (var key in assets.Select(pair => pair.Key).ToArray())
            if (!files.Contains(key)) assets.Remove(key);
    }
    Require(deps["libraries"]!.AsObject().Count == 1 && deps["libraries"]![packageName] is not null,
        "Unsupported framework library layout");

    // Only copy selected files into a fresh directory; never modify the source SDK.
    var version = Text(build, "runtimeVersion");
    var outputFramework = FrameworkDirectory(destination, build);
    foreach (var file in managedFiles.Concat(nativeFiles))
        CopyFile(Path.Combine(framework, file), Path.Combine(outputFramework, file));
    WriteJson(Path.Combine(outputFramework, "Microsoft.NETCore.App.deps.json"), deps);
    CopyFile(Path.Combine(framework, "Microsoft.NETCore.App.runtimeconfig.json"),
        Path.Combine(outputFramework, "Microsoft.NETCore.App.runtimeconfig.json"));
    foreach (var file in new[]
    {
        $"runtime/host/fxr/{version}/{hostfxr}", $"bin/{nethost}",
        triplet == "x64-windows-star" ? "lib/nethost.lib" : "lib/libnethost.a",
        "include/nethost.h", "include/hostfxr.h", "include/coreclr_delegates.h", "include/host_error_codes.h",
        "share/dotnet/StarDotNetConfig.cmake", "LICENSE.TXT", "THIRD-PARTY-NOTICES.TXT",
        "provenance/runtime-global.json", "provenance/dotnet-version.cmake"
    }) CopyFile(Path.Combine(source, file), Path.Combine(destination, file));
    CopyFile(buildPath, Path.Combine(destination, "provenance", "source-build.json"));
    CopyFile(profilePath, Path.Combine(destination, "provenance", "profile.json"));
    build["profile"] = profileName;
    build["profileSha256"] = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(profilePath)));
    build["sourcePayloadSha256"] = Convert.ToHexStringLower(SHA256.HashData(
        File.ReadAllBytes(Path.Combine(source, "provenance", "files.sha256"))));
    WriteJson(Path.Combine(destination, "provenance", "build.json"), build);
    WriteJson(Path.Combine(destination, "provenance", "selection.json"), new
    {
        profile = profileName, managedRoots = roots, managedAssemblies = selected,
        managedReferences = references, nativeFrameworkFiles = nativeFiles, nativeImports = imports
    });
    File.AppendAllText(Path.Combine(destination, "share", "dotnet", "StarDotNetConfig.cmake"),
        $"\nset(StarDotNet_PROFILE \"{profileName}\")\n");
    Console.WriteLine($"Selected {roots.Length} managed roots, {selected.Count} assemblies and {nativeFiles.Length} native framework files.");
}

static void CheckApplications(string sdk, string applications)
{
    var build = ReadObject(Path.Combine(sdk, "provenance", "build.json"));
    var framework = FrameworkDirectory(sdk, build);
    var available = new Dictionary<string, Version>(StringComparer.OrdinalIgnoreCase);
    foreach (var file in Directory.GetFiles(framework, "*.dll"))
    {
        using var stream = File.OpenRead(file);
        using var pe = new PEReader(stream);
        if (!pe.HasMetadata) continue;
        var assembly = Inspect(file);
        available.Add(assembly.Name, assembly.Version);
    }
    var files = Directory.GetFiles(applications, "*.dll", SearchOption.AllDirectories);
    Require(files.Length > 0, "No application assemblies to check");
    foreach (var file in files)
    {
        var assembly = Inspect(file);
        Require(available.TryAdd(assembly.Name, assembly.Version), $"Duplicate or framework-shadowing application assembly: {assembly.Name}");
    }
    foreach (var file in files)
    {
        var assembly = Inspect(file);
        foreach (var reference in assembly.References)
            Require(available.TryGetValue(reference.Name, out var version) && version >= reference.Version,
                $"Missing application dependency: {assembly.Name} -> {reference.Name} {reference.Version}");
    }
    Console.WriteLine($"Application references verified: {files.Length} assemblies.");
}
