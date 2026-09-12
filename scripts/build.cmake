cmake_minimum_required(VERSION 3.24)

get_filename_component(root "${CMAKE_CURRENT_LIST_DIR}/.." ABSOLUTE)
# Use this repository's vcpkg, regardless of the caller's environment.
set(ENV{VCPKG_ROOT} "${root}/tools/vcpkg")
# Limit the initial pipeline to Windows and macOS host builds.
if(NOT DEFINED TRIPLET)
  message(FATAL_ERROR "Pass -DTRIPLET=x64-windows-star or arm64-osx-star")
endif()
if(NOT TRIPLET MATCHES "^(x64-windows-star|arm64-osx-star)$")
  message(FATAL_ERROR "Unsupported triplet: ${TRIPLET}")
endif()
if(TRIPLET STREQUAL "x64-windows-star" AND NOT CMAKE_HOST_WIN32)
  message(FATAL_ERROR "Windows target requires a Windows host")
elseif(TRIPLET STREQUAL "arm64-osx-star" AND NOT CMAKE_HOST_APPLE)
  message(FATAL_ERROR "macOS target requires a macOS host")
endif()

# Run from the repository root and stop immediately on command failure.
function(run)
  execute_process(COMMAND ${ARGV} WORKING_DIRECTORY "${root}"
    COMMAND_ERROR_IS_FATAL ANY)
endfunction()

# Keep the tool checkout and dependency baseline aligned by project convention.
file(READ "${root}/vcpkg.json" manifest)
string(JSON baseline GET "${manifest}" builtin-baseline)
execute_process(COMMAND git -C "${root}/tools/vcpkg" rev-parse HEAD
  OUTPUT_VARIABLE revision OUTPUT_STRIP_TRAILING_WHITESPACE
  COMMAND_ERROR_IS_FATAL ANY)
if(NOT revision STREQUAL baseline)
  message(FATAL_ERROR "vcpkg submodule and builtin-baseline must match")
endif()

# Isolate target outputs and bootstrap the host-specific vcpkg executable.
set(output "${root}/out/${TRIPLET}")
file(MAKE_DIRECTORY "${output}")
if(CMAKE_HOST_WIN32)
  run(cmd /c "${root}/tools/vcpkg/bootstrap-vcpkg.bat" -disableMetrics)
  set(vcpkg "${root}/tools/vcpkg/vcpkg.exe")
else()
  run(bash "${root}/tools/vcpkg/bootstrap-vcpkg.sh" -disableMetrics)
  set(vcpkg "${root}/tools/vcpkg/vcpkg")
endif()

# Install dependencies, then package only the target's files (not host tools).
run("${vcpkg}" install "--triplet=${TRIPLET}"
  "--x-manifest-root=${root}" "--x-install-root=${output}/installed")
set(base "star-binaries-${TRIPLET}")
set(installed "${output}/installed/${TRIPLET}")
set(sdk "${output}/${base}-sdk")
# Keep both configurations together so upstream CMake exports remain valid.
file(REMOVE_RECURSE "${sdk}")
file(GLOB old_archives "${output}/${base}*.zip" "${output}/${base}*.zip.sha256")
if(old_archives)
  file(REMOVE ${old_archives})
endif()
file(MAKE_DIRECTORY "${sdk}")
file(COPY "${installed}/" DESTINATION "${sdk}"
  PATTERN "*.pdb" EXCLUDE
  PATTERN "*.dSYM" EXCLUDE)
file(REMOVE_RECURSE "${sdk}/share/doc" "${sdk}/share/man")

file(GLOB_RECURSE metadata LIST_DIRECTORIES false RELATIVE "${installed}"
  "${installed}/share/*/copyright" "${installed}/share/*/LICENSE*"
  "${installed}/share/*/vcpkg.spdx.json"
  "${installed}/share/*/vcpkg-spdx-resources.json")

# Include build inputs and revisions for tracing the package's origin.
file(COPY "${root}/vcpkg.json" "${root}/vcpkg-configuration.json"
  "${root}/triplets" DESTINATION "${sdk}/provenance")
execute_process(COMMAND git -C "${root}" rev-parse HEAD
  OUTPUT_VARIABLE source_revision OUTPUT_STRIP_TRAILING_WHITESPACE
  COMMAND_ERROR_IS_FATAL ANY)
file(WRITE "${sdk}/provenance/build.txt"
  "source=${source_revision}\nvcpkg=${revision}\ntriplet=${TRIPLET}\nconfigurations=Release,Debug\ncmake=${CMAKE_VERSION}\nhost=${CMAKE_HOST_SYSTEM}\n")

# Archive with relative paths and provide a checksum for download verification.
set(relocated "${output}/relocated")
file(REMOVE_RECURSE "${relocated}")
file(MAKE_DIRECTORY "${relocated}")
function(archive_package package kind)
  set(archive "${output}/${package}.zip")
  execute_process(COMMAND "${CMAKE_COMMAND}" -E tar cf "${archive}"
    --format=zip "${package}" WORKING_DIRECTORY "${output}"
    COMMAND_ERROR_IS_FATAL ANY)
  file(SHA256 "${archive}" checksum)
  file(WRITE "${archive}.sha256" "${checksum}  ${package}.zip\n")
  file(ARCHIVE_EXTRACT INPUT "${archive}" DESTINATION "${relocated}")
  file(GLOB_RECURSE entries LIST_DIRECTORIES false RELATIVE "${relocated}/${package}"
    "${relocated}/${package}/*")
  foreach(entry IN LISTS entries)
    if(entry MATCHES "^(installed/|scripts/|vcpkg\\.exe$)" OR
       entry MATCHES "\\.(pdf|exe)$")
      message(FATAL_ERROR "Unexpected package content: ${package}/${entry}")
    endif()
    if(NOT kind STREQUAL "symbols" AND entry MATCHES "(\\.pdb$|\\.dSYM/)")
      message(FATAL_ERROR "Debug symbol outside symbol package: ${entry}")
    endif()
    if(kind STREQUAL "symbols" AND NOT entry MATCHES
       "(^provenance/|^share/|\\.pdb$|\\.dSYM/)")
      message(FATAL_ERROR "Non-symbol payload in symbol package: ${entry}")
    endif()
    if(kind STREQUAL "runtime" AND NOT entry MATCHES
       "(^provenance/|^share/|\\.dll$|\\.dylib$)")
      message(FATAL_ERROR "Non-runtime payload in runtime package: ${entry}")
    endif()
  endforeach()
endfunction()
archive_package("${base}-sdk" sdk)

foreach(configuration Release Debug)
  string(TOLOWER "${configuration}" config_name)
  set(config_root "${installed}")
  if(configuration STREQUAL "Debug")
    set(config_root "${installed}/debug")
  endif()
  set(runtime "${output}/${base}-${config_name}-runtime")
  set(symbols "${output}/${base}-${config_name}-symbols")
  file(REMOVE_RECURSE "${runtime}" "${symbols}")
  file(MAKE_DIRECTORY "${runtime}")

  # Flatten the chosen configuration for deployment, preserving dylib symlinks.
  file(GLOB_RECURSE runtime_files LIST_DIRECTORIES false RELATIVE "${config_root}"
    "${config_root}/bin/*.dll" "${config_root}/lib/*.dylib")
  if(NOT runtime_files)
    message(FATAL_ERROR "No ${configuration} dynamic libraries found for ${TRIPLET}")
  endif()
  foreach(relative IN LISTS runtime_files)
    get_filename_component(directory "${relative}" DIRECTORY)
    file(COPY "${config_root}/${relative}" DESTINATION "${runtime}/${directory}")
  endforeach()
  foreach(relative IN LISTS metadata)
    get_filename_component(directory "${relative}" DIRECTORY)
    file(COPY "${installed}/${relative}" DESTINATION "${runtime}/${directory}")
  endforeach()
  file(COPY "${sdk}/provenance" DESTINATION "${runtime}")
  file(WRITE "${runtime}/provenance/configuration.txt" "${configuration}\n")
  archive_package("${base}-${config_name}-runtime" runtime)

  # Search bin/lib only, so Release symbols cannot include debug/ contents.
  file(GLOB_RECURSE symbol_files LIST_DIRECTORIES false RELATIVE "${config_root}"
    "${config_root}/bin/*.pdb" "${config_root}/lib/*.pdb")
  file(GLOB_RECURSE symbol_bundles LIST_DIRECTORIES true RELATIVE "${config_root}"
    "${config_root}/bin/*.dSYM" "${config_root}/lib/*.dSYM")
  list(FILTER symbol_bundles INCLUDE REGEX "\\.dSYM$")
  list(APPEND symbol_files ${symbol_bundles})
  if(symbol_files)
    foreach(relative IN LISTS symbol_files)
      get_filename_component(directory "${relative}" DIRECTORY)
      file(COPY "${config_root}/${relative}" DESTINATION "${symbols}/${directory}")
    endforeach()
    file(COPY "${runtime}/provenance" "${runtime}/share" DESTINATION "${symbols}")
    archive_package("${base}-${config_name}-symbols" symbols)
  endif()

# Test each configuration against the extracted SDK and its matching runtime.
set(prefix "${relocated}/${base}-sdk")
set(runtime_prefix "${relocated}/${base}-${config_name}-runtime")
set(consumer_build "${output}/consumer-${config_name}")
set(platform_options)
if(CMAKE_HOST_APPLE)
  list(APPEND platform_options -DCMAKE_OSX_ARCHITECTURES=arm64
    -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 "-DCMAKE_BUILD_TYPE=${configuration}")
elseif(CMAKE_HOST_WIN32)
  list(APPEND platform_options -A x64)
endif()
# Clear cached paths and consume via CMAKE_PREFIX_PATH, without a vcpkg toolchain.
run("${CMAKE_COMMAND}" --fresh -S "${root}/tests/consumer" -B "${consumer_build}"
  "-DCMAKE_PREFIX_PATH=${prefix}"
  "-DSTAR_RUNTIME_ROOT=${runtime_prefix}"
  "-DSTAR_CONFIGURATION=${configuration}"
  ${platform_options})
run("${CMAKE_COMMAND}" --build "${consumer_build}" --config "${configuration}")
run("${CMAKE_COMMAND}" --install "${consumer_build}" --config "${configuration}"
  --prefix "${runtime_prefix}")
run("${CMAKE_CTEST_COMMAND}" --test-dir "${consumer_build}"
  -C "${configuration}" --output-on-failure)
endforeach()