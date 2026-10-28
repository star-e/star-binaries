#pragma once
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <vector>
#ifdef _WIN32
#include <windows.h>
#define HOST_TEXT(text) L##text
#define HOST_CDECL __cdecl
#else
#include <dlfcn.h>
#include <mach-o/dyld.h>
#define HOST_TEXT(text) text
#define HOST_CDECL
#endif

namespace fs = std::filesystem;

inline void require(bool condition, const char* message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

inline fs::path libraryPath(const fs::path& directory, const char* name) {
#ifdef _WIN32
  return directory / (std::string(name) + ".dll");
#else
  return directory / ("lib" + std::string(name) + ".dylib");
#endif
}

#ifdef _WIN32
using NativeModule = HMODULE;

inline fs::path modulePath(HMODULE module) {
  std::wstring path(32768, L'\0');
  const auto size = GetModuleFileNameW(module, path.data(), static_cast<DWORD>(path.size()));
  require(size != 0 && size < path.size(), "Cannot read native module path");
  path.resize(size);
  return path;
}

inline fs::path loadedModulePath(const fs::path& name) {
  const auto module = GetModuleHandleW(name.c_str());
  return module ? modulePath(module) : fs::path{};
}

inline fs::path executablePath() {
  return modulePath(GetModuleHandleW(nullptr));
}
#else
using NativeModule = void*;

inline fs::path loadedModulePath(const fs::path& name) {
  for (uint32_t i = 0; i < _dyld_image_count(); ++i) {
    const auto* image = _dyld_get_image_name(i);
    if (image && fs::path(image).filename() == name) {
      return image;
    }
  }
  return {};
}

inline fs::path executablePath() {
  uint32_t size = 0;
  _NSGetExecutablePath(nullptr, &size);
  std::vector<char> path(size);
  require(_NSGetExecutablePath(path.data(), &size) == 0, "Cannot read executable path");
  return fs::canonical(path.data());
}
#endif

inline void requireModule(const fs::path& expected) {
  const auto actual = loadedModulePath(expected.filename());
  require(!actual.empty(), "Required native module is not loaded");
  std::printf("Loaded: %s\n", actual.u8string().c_str());
  require(fs::equivalent(actual, expected), "Loaded native module is outside the selected SDK");
}

inline NativeModule loadModule(const fs::path& path) {
#ifdef _WIN32
  auto module = LoadLibraryExW(path.c_str(), nullptr,
      LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
  if (!module) {
    throw std::runtime_error("LoadLibraryEx failed: " + std::to_string(GetLastError()));
  }
#else
  auto module = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
  if (!module) {
    throw std::runtime_error(dlerror());
  }
#endif
  requireModule(path);
  // CoreCLR is process-wide; keep its hosting libraries loaded until exit.
  return module;
}

template<class T>
T symbol(NativeModule module, const char* name) {
#ifdef _WIN32
  auto address = GetProcAddress(module, name);
#else
  auto address = dlsym(module, name);
#endif
  require(address != nullptr, "Missing native hosting export");
  return reinterpret_cast<T>(address);
}
