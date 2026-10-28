#include <windows.h>
#include <coreclr_delegates.h>
#include <hostfxr.h>
#include <host_error_codes.h>
#include <nethost.h>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <vector>

namespace fs = std::filesystem;
namespace {

void require(bool condition, const char* message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

fs::path modulePath(HMODULE module) {
  require(module != nullptr, "Required native module is not loaded");
  std::wstring path(32768, L'\0');
  const auto size = GetModuleFileNameW(module, path.data(), static_cast<DWORD>(path.size()));
  require(size != 0 && size < path.size(), "Cannot read native module path");
  path.resize(size);
  return path;
}

void requireModule(HMODULE module, const fs::path& expected) {
  const auto actual = modulePath(module);
  std::printf("Loaded: %s\n", actual.u8string().c_str());
  require(fs::equivalent(actual, expected), "Loaded native module is outside the selected SDK");
}

HMODULE loadModule(const fs::path& path) {
  auto module = LoadLibraryExW(path.c_str(), nullptr,
      LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
  require(module != nullptr, "Cannot load native hosting library");
  requireModule(module, path);
  // The runtime is process-wide. Keep its hosting libraries loaded until exit.
  return module;
}

template<class T>
T symbol(HMODULE module, const char* name) {
  auto address = GetProcAddress(module, name);
  require(address != nullptr, "Missing native hosting export");
  return reinterpret_cast<T>(address);
}

int callbackCount = 0;
int __cdecl nativeCallback(int value) noexcept {
  ++callbackCount;
  return value + 1;
}

struct Request {
  int(__cdecl* callback)(int);
  const wchar_t* coreLibPath;
  const wchar_t* version;
  const wchar_t* revision;
};

} // namespace

int wmain(int argc, wchar_t** argv) {
  try {
    require(argc == 6 || argc == 7, "Usage: consumer <sdk> <assembly> <runtimeconfig> <version> <revision> [--expect-missing-runtime]");
    const bool expectMissing = argc == 7 && std::wstring(argv[6]) == L"--expect-missing-runtime";
    require(argc == 6 || expectMissing, "Unknown argument");
    const auto sdk = fs::canonical(argv[1]);
    const auto assembly = fs::canonical(argv[2]);
    const auto config = fs::canonical(argv[3]);
    const auto runtime = sdk / L"runtime";
    const auto framework = runtime / L"shared" / L"Microsoft.NETCore.App" / argv[4];
    const auto expectedFxr = runtime / L"host" / L"fxr" / argv[4] / L"hostfxr.dll";
    const auto nethost = loadModule(sdk / L"bin" / L"nethost.dll");
    auto getFxrPath = symbol<decltype(&get_hostfxr_path)>(nethost, "get_hostfxr_path");
    const get_hostfxr_parameters search{sizeof(search), nullptr, runtime.c_str()};
    std::vector<wchar_t> fxrPath(32768);
    size_t pathSize = fxrPath.size();
    require(getFxrPath(fxrPath.data(), &pathSize, &search) == 0, "Cannot locate packaged hostfxr");
    require(fs::equivalent(fxrPath.data(), expectedFxr), "hostfxr lookup escaped selected runtime");
    auto fxr = loadModule(fxrPath.data());
    auto initialize = symbol<hostfxr_initialize_for_runtime_config_fn>(fxr, "hostfxr_initialize_for_runtime_config");
    auto getDelegate = symbol<hostfxr_get_runtime_delegate_fn>(fxr, "hostfxr_get_runtime_delegate");
    auto close = symbol<hostfxr_close_fn>(fxr, "hostfxr_close");
    const auto executable = modulePath(GetModuleHandleW(nullptr));
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
      require(GetModuleHandleW(L"coreclr.dll") == nullptr, "Unexpected CLR loaded during rejection");
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
    require(loadAssembly(assembly.c_str(), L"Star.DotNet.Smoke, Star.DotNet.Smoke", L"Run",
        UNMANAGEDCALLERSONLY_METHOD, nullptr, &method) == 0 && method != nullptr,
        "Cannot load managed entry point");
    const auto coreLib = framework / L"System.Private.CoreLib.dll";
    Request request{nativeCallback, coreLib.c_str(), argv[4], argv[5]};
    using Run = int(__cdecl*)(void*, int);
    require(reinterpret_cast<Run>(method)(&request, sizeof(request)) == 0, "Managed smoke test failed");
    require(callbackCount == 1, "Native callback count mismatch");
    requireModule(GetModuleHandleW(L"coreclr.dll"), framework / L"coreclr.dll");
    requireModule(GetModuleHandleW(L"clrjit.dll"), framework / L"clrjit.dll");
    requireModule(GetModuleHandleW(L"hostpolicy.dll"), framework / L"hostpolicy.dll");
    std::puts("STAR_DOTNET_SMOKE_PASSED");
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "%s (Win32 error %lu)\n", error.what(), GetLastError());
    return 1;
  }
}
