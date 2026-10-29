# Mobile runtime packs use the upstream bootstrap SDK on the build host.
# They do not use the desktop consumer SDK or hostfxr distribution layout.
set(dotnet_mobile TRUE)
if(TRIPLET MATCHES "^(arm64|x64)-android-star$")
  set(dotnet_arch "${CMAKE_MATCH_1}")
  set(dotnet_os android)
  set(dotnet_build_host "Linux x64")
  set(dotnet_subsets "clr.runtime+clr.alljits+clr.corelib+clr.nativecorelib+clr.tools+clr.packages+libs+host+packs")
  set(dotnet_execution "JIT+ReadyToRun")
elseif(TRIPLET STREQUAL "arm64-ios-star" OR TRIPLET STREQUAL "arm64-ios-simulator-star")
  set(dotnet_arch arm64)
  if(TRIPLET STREQUAL "arm64-ios-star")
    set(dotnet_os ios)
  else()
    set(dotnet_os iossimulator)
  endif()
  set(dotnet_build_host "macOS arm64")
  set(dotnet_subsets "clr+clr.runtime+libs+packs")
  set(dotnet_execution "Interpreter+ReadyToRun")
else()
  message(FATAL_ERROR "Unsupported mobile CoreCLR triplet: ${TRIPLET}")
endif()
set(dotnet_rid "${dotnet_os}-${dotnet_arch}")
set(dotnet_package_id "Microsoft.NETCore.App.Runtime.${dotnet_rid}")
set(dotnet_mobile_build_args -subset "${dotnet_subsets}" -configuration Release
  -arch "${dotnet_arch}" -os "${dotnet_os}" -ci
  "/p:RuntimeFlavor=CoreCLR" "/p:VersionSuffix=${STAR_DOTNET_VERSION_SUFFIX}"
  /p:GenerateInstallers=false /p:GenerateVSInsertionPackages=false /p:SkipInstallerBuild=true
  /p:IncludeSourceRevisionInInformationalVersion=true "/p:SourceRevisionId=${STAR_DOTNET_REVISION}"
  "/maxcpucount:${JOBS}")
if(NOT dotnet_os STREQUAL "android")
  list(APPEND dotnet_mobile_build_args -cross /p:FeatureInterpreter=true /p:FeatureDynamicCodeCompiled=false)
endif()

function(star_dotnet_require_host)
  if(dotnet_os STREQUAL "android" AND CMAKE_HOST_SYSTEM_NAME STREQUAL "Linux")
    set(expected_arch x86_64)
  elseif(NOT dotnet_os STREQUAL "android" AND CMAKE_HOST_SYSTEM_NAME STREQUAL "Darwin")
    set(expected_arch arm64)
  else()
    message(FATAL_ERROR "${TRIPLET} requires ${dotnet_build_host}; use the mobile CI job or a matching host")
  endif()
  execute_process(COMMAND uname -m OUTPUT_VARIABLE architecture
    OUTPUT_STRIP_TRAILING_WHITESPACE COMMAND_ERROR_IS_FATAL ANY)
  if(NOT architecture STREQUAL expected_arch)
    message(FATAL_ERROR "${TRIPLET} requires ${dotnet_build_host}; found ${architecture}")
  endif()
endfunction()
