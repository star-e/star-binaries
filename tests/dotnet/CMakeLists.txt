cmake_minimum_required(VERSION 3.26)
project(StarDotNetConsumer LANGUAGES CXX)
if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8 OR NOT (WIN32 OR APPLE))
  message(FATAL_ERROR "The CoreCLR consumer requires Windows x64 or macOS arm64")
endif()
find_package(StarDotNet CONFIG REQUIRED PATHS "${STAR_SDK_ROOT}/share/dotnet"
  NO_DEFAULT_PATH NO_CMAKE_FIND_ROOT_PATH)
if(WIN32 AND StarDotNet_TRIPLET STREQUAL "x64-windows-star" AND
   CMAKE_SYSTEM_PROCESSOR MATCHES "^(AMD64|amd64|x86_64)$")
elseif(APPLE AND StarDotNet_TRIPLET STREQUAL "arm64-osx-star" AND
       CMAKE_OSX_ARCHITECTURES STREQUAL "arm64")
else()
  message(FATAL_ERROR "Unexpected CoreCLR SDK target")
endif()
if(NOT EXISTS "${DOTNET_EXECUTABLE}")
  message(FATAL_ERROR "Pass the pinned consumer compiler as DOTNET_EXECUTABLE")
endif()
add_executable(dotnet_consumer main.cpp)
target_link_libraries(dotnet_consumer PRIVATE StarDotNet::Hosting ${CMAKE_DL_LIBS})
set_target_properties(dotnet_consumer PROPERTIES CXX_STANDARD 17 CXX_STANDARD_REQUIRED YES CXX_EXTENSIONS NO)
if(WIN32)
  target_compile_definitions(dotnet_consumer PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
endif()

# Build in an isolated directory: never write obj/bin into the source checkout.
file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/managed-source")
configure_file(Smoke.cs "${CMAKE_CURRENT_BINARY_DIR}/managed-source/Smoke.cs" COPYONLY)
configure_file(Smoke.csproj "${CMAKE_CURRENT_BINARY_DIR}/managed-source/Smoke.csproj" COPYONLY)
configure_file(NuGet.Config "${CMAKE_CURRENT_BINARY_DIR}/managed-source/NuGet.Config" COPYONLY)
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/managed-source/global.json"
  "{\"sdk\":{\"version\":\"${CONSUMER_SDK_VERSION}\",\"rollForward\":\"disable\",\"allowPrerelease\":true}}\n")
add_custom_command(OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/managed/Star.DotNet.Smoke.dll"
  COMMAND "${CMAKE_COMMAND}" -E env --unset=LIB --unset=LIBPATH DOTNET_CLI_TELEMETRY_OPTOUT=1
    DOTNET_GENERATE_ASPNET_CERTIFICATE=false DOTNET_ADD_GLOBAL_TOOLS_TO_PATH=false
    "DOTNET_CLI_HOME=${CMAKE_CURRENT_BINARY_DIR}/dotnet-home"
    "${DOTNET_EXECUTABLE}" build Smoke.csproj -c Release
    --output "${CMAKE_CURRENT_BINARY_DIR}/managed" --nologo
  WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/managed-source"
  DEPENDS Smoke.cs Smoke.csproj NuGet.Config
    "${CMAKE_CURRENT_BINARY_DIR}/managed-source/global.json" VERBATIM)
add_custom_target(dotnet_managed ALL DEPENDS "${CMAKE_CURRENT_BINARY_DIR}/managed/Star.DotNet.Smoke.dll")
file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/managed")
set(runtime_version "${StarDotNet_RUNTIME_VERSION}")
configure_file(runtimeconfig.json.in "${CMAKE_CURRENT_BINARY_DIR}/managed/Star.DotNet.Smoke.runtimeconfig.json" @ONLY)
set(runtime_version "99.0.0-star.missing")
configure_file(runtimeconfig.json.in "${CMAKE_CURRENT_BINARY_DIR}/missing.runtimeconfig.json" @ONLY)
enable_testing()
add_test(NAME dotnet.native-managed-callback COMMAND dotnet_consumer
  "${STAR_SDK_ROOT}" "${CMAKE_CURRENT_BINARY_DIR}/managed/Star.DotNet.Smoke.dll"
  "${CMAKE_CURRENT_BINARY_DIR}/managed/Star.DotNet.Smoke.runtimeconfig.json"
  "${StarDotNet_RUNTIME_VERSION}" "${StarDotNet_REVISION}")
set_tests_properties(dotnet.native-managed-callback PROPERTIES
  TIMEOUT 60 PASS_REGULAR_EXPRESSION STAR_DOTNET_SMOKE_PASSED)
add_test(NAME dotnet.reject-missing-runtime COMMAND dotnet_consumer
  "${STAR_SDK_ROOT}" "${CMAKE_CURRENT_BINARY_DIR}/managed/Star.DotNet.Smoke.dll"
  "${CMAKE_CURRENT_BINARY_DIR}/missing.runtimeconfig.json"
  "${StarDotNet_RUNTIME_VERSION}" "${StarDotNet_REVISION}" --expect-missing-runtime)
set_tests_properties(dotnet.reject-missing-runtime PROPERTIES
  TIMEOUT 60 PASS_REGULAR_EXPRESSION STAR_DOTNET_MISSING_RUNTIME_REJECTED)
