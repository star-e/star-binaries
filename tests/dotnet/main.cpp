#include "platform.h"
#include <coreclr_delegates.h>
#include <hostfxr.h>
#include <host_error_codes.h>
#include <nethost.h>
namespace {

int callbackCount = 0;
int HOST_CDECL nativeCallback(int value) noexcept {
  ++callbackCount;
  return value + 1;
}

void HOST_CDECL logMessage(const unsigned char* message, int length) noexcept {
  if (message && length > 0) {
    std::fwrite(message, 1, static_cast<size_t>(length), stdout);
    std::fputc('\n', stdout);
  }
}

struct Request {
  int(HOST_CDECL* callback)(int);
  // The test ABI uses UTF-8 on both platforms, independently of hostfxr's char_t.
  const char* coreLibPath;
  const char* version;
  const char* revision;
  void(HOST_CDECL* log)(const unsigned char*, int);
  const char* profile;
};

} // namespace

#ifdef _WIN32
int wmain(int argc, wchar_t** argv) {
#else
int main(int argc, char** argv) {
#endif
  try {
    require(argc == 7 || argc == 8, "Usage: consumer <sdk> <assembly> <runtimeconfig> <version> <revision> <profile> [--expect-missing-runtime]");
    const bool expectMissing = argc == 8 && std::basic_string<char_t>(argv[7]) == HOST_TEXT("--expect-missing-runtime");
    require(argc == 7 || expectMissing, "Unknown argument");
    const auto sdk = fs::canonical(argv[1]);
    const auto assembly = fs::canonical(argv[2]);
    const auto config = fs::canonical(argv[3]);
    const auto runtime = sdk / "runtime";
    const auto framework = runtime / "shared" / "Microsoft.NETCore.App" / argv[4];
    const auto expectedFxr = libraryPath(runtime / "host" / "fxr" / argv[4], "hostfxr");
    const auto nethost = loadModule(libraryPath(sdk / "bin", "nethost"));
    auto getFxrPath = symbol<decltype(&get_hostfxr_path)>(nethost, "get_hostfxr_path");
    const get_hostfxr_parameters search{sizeof(search), nullptr, runtime.c_str()};
    std::vector<char_t> fxrPath(32768);
    size_t pathSize = fxrPath.size();
    require(getFxrPath(fxrPath.data(), &pathSize, &search) == 0, "Cannot locate packaged hostfxr");
    require(fs::equivalent(fxrPath.data(), expectedFxr), "hostfxr lookup escaped selected runtime");
    auto fxr = loadModule(fxrPath.data());
    auto initialize = symbol<hostfxr_initialize_for_runtime_config_fn>(fxr, "hostfxr_initialize_for_runtime_config");
    auto getDelegate = symbol<hostfxr_get_runtime_delegate_fn>(fxr, "hostfxr_get_runtime_delegate");
    auto close = symbol<hostfxr_close_fn>(fxr, "hostfxr_close");
    const auto executable = executablePath();
    const hostfxr_initialize_parameters parameters{sizeof(parameters), executable.c_str(), runtime.c_str()};
    hostfxr_handle context = nullptr;
    const auto status = initialize(config.c_str(), &parameters, &context);
    if (expectMissing) {
      if (context) {
        close(context);
      }
      // FrameworkMissingFailure; arbitrary initialization errors must not pass.
      require(static_cast<uint32_t>(status) == static_cast<uint32_t>(FrameworkMissingFailure),
          "Expected missing-framework rejection");
      require(loadedModulePath(libraryPath({}, "coreclr")).empty(), "Unexpected CLR loaded during rejection");
      std::puts("STAR_DOTNET_MISSING_RUNTIME_REJECTED");
      return 0;
    }
    require(status == 0 && context != nullptr, "Cannot initialize packaged runtime");
    void* entry = nullptr;
    const auto delegateStatus = getDelegate(context, hdt_load_assembly_and_get_function_pointer, &entry);
    const auto closeStatus = close(context);
    require(delegateStatus == 0 && entry != nullptr && closeStatus == 0, "Cannot obtain managed loader");
    auto loadAssembly = reinterpret_cast<load_assembly_and_get_function_pointer_fn>(entry);
    void* method = nullptr;
    require(loadAssembly(assembly.c_str(), HOST_TEXT("Star.DotNet.Smoke, Star.DotNet.Smoke"), HOST_TEXT("Run"),
        UNMANAGEDCALLERSONLY_METHOD, nullptr, &method) == 0 && method != nullptr,
        "Cannot load managed entry point");
    const auto coreLib = (framework / "System.Private.CoreLib.dll").u8string();
    const auto version = fs::path(argv[4]).u8string();
    const auto revision = fs::path(argv[5]).u8string();
    const auto profile = fs::path(argv[6]).u8string();
    Request request{nativeCallback, coreLib.c_str(), version.c_str(), revision.c_str(), logMessage, profile.c_str()};
    using Run = int(HOST_CDECL*)(void*, int);
    require(reinterpret_cast<Run>(method)(&request, sizeof(request)) == 0, "Managed smoke test failed");
    require(callbackCount == 1, "Native callback count mismatch");
    requireModule(libraryPath(framework, "coreclr"));
    requireModule(libraryPath(framework, "clrjit"));
    requireModule(libraryPath(framework, "hostpolicy"));
    std::puts("STAR_DOTNET_SMOKE_PASSED");
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
  }
}
