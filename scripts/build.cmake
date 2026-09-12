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
set(base "star-binaries-${TRIPLET}-release")
set(installed "${output}/installed/${TRIPLET}")
set(sdk "${output}/${base}-sdk")
set(runtime "${output}/${base}-runtime")
set(symbols "${output}/${base}-symbols")
# Remove previous package outputs, including the old full vcpkg export.
file(REMOVE_RECURSE "${output}/${base}" "${sdk}" "${runtime}" "${symbols}")
file(REMOVE "${output}/${base}.zip" "${output}/${base}.zip.sha256")
foreach(kind sdk runtime symbols)
  file(REMOVE "${output}/${base}-${kind}.zip" "${output}/${base}-${kind}.zip.sha256")
endforeach()
file(MAKE_DIRECTORY "${sdk}" "${runtime}")
file(COPY "${installed}/" DESTINATION "${sdk}"
  PATTERN "*.pdb" EXCLUDE
  PATTERN "*.dSYM" EXCLUDE)
file(REMOVE_RECURSE "${sdk}/share/doc" "${sdk}/share/man")

# Preserve relative library paths and symlinks for runtime deployment.
file(GLOB_RECURSE runtime_files LIST_DIRECTORIES false RELATIVE "${installed}"
  "${installed}/bin/*.dll" "${installed}/lib/*.dylib")
if(NOT runtime_files)
  message(FATAL_ERROR "No dynamic libraries found for ${TRIPLET}")
endif()
foreach(relative IN LISTS runtime_files)
  get_filename_component(directory "${relative}" DIRECTORY)
  file(COPY "${installed}/${relative}" DESTINATION "${runtime}/${directory}")
endforeach()
file(GLOB_RECURSE metadata LIST_DIRECTORIES false RELATIVE "${installed}"
  "${installed}/share/*/copyright" "${installed}/share/*/LICENSE*"
  "${installed}/share/*/vcpkg.spdx.json"
  "${installed}/share/*/vcpkg-spdx-resources.json")
foreach(relative IN LISTS metadata)
  get_filename_component(directory "${relative}" DIRECTORY)
  file(COPY "${installed}/${relative}" DESTINATION "${runtime}/${directory}")
endforeach()

# Keep available debug symbols separate; do not publish empty symbol packages.
file(GLOB_RECURSE symbol_files LIST_DIRECTORIES false RELATIVE "${installed}"
  "${installed}/*.pdb")
file(GLOB_RECURSE symbol_bundles LIST_DIRECTORIES true RELATIVE "${installed}"
  "${installed}/*.dSYM")
list(FILTER symbol_bundles INCLUDE REGEX "\\.dSYM$")
list(APPEND symbol_files ${symbol_bundles})
foreach(relative IN LISTS symbol_files)
  get_filename_component(directory "${relative}" DIRECTORY)
  file(COPY "${installed}/${relative}" DESTINATION "${symbols}/${directory}")
endforeach()

# Include build inputs and revisions for tracing the package's origin.
file(COPY "${root}/vcpkg.json" "${root}/vcpkg-configuration.json"
  "${root}/triplets" DESTINATION "${sdk}/provenance")
execute_process(COMMAND git -C "${root}" rev-parse HEAD
  OUTPUT_VARIABLE source_revision OUTPUT_STRIP_TRAILING_WHITESPACE
  COMMAND_ERROR_IS_FATAL ANY)
file(WRITE "${sdk}/provenance/build.txt"
  "source=${source_revision}\nvcpkg=${revision}\ntriplet=${TRIPLET}\ncmake=${CMAKE_VERSION}\nhost=${CMAKE_HOST_SYSTEM}\n")
file(COPY "${sdk}/provenance" DESTINATION "${runtime}")
set(kinds sdk runtime)
if(symbol_files)
  file(COPY "${sdk}/provenance" "${runtime}/share" DESTINATION "${symbols}")
  list(APPEND kinds symbols)
endif()

# Archive with relative paths and provide a checksum for download verification.
set(relocated "${output}/relocated")
file(REMOVE_RECURSE "${relocated}")
file(MAKE_DIRECTORY "${relocated}")
foreach(kind IN LISTS kinds)
  set(package "${base}-${kind}")
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
endforeach()
# Test the extracted packages, not the original installation.
set(prefix "${relocated}/${base}-sdk")
set(runtime_prefix "${relocated}/${base}-runtime")
set(platform_options)
if(CMAKE_HOST_APPLE)
  list(APPEND platform_options -DCMAKE_OSX_ARCHITECTURES=arm64
    -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 -DCMAKE_BUILD_TYPE=Release)
elseif(CMAKE_HOST_WIN32)
  list(APPEND platform_options -A x64)
endif()
# Clear cached paths and consume via CMAKE_PREFIX_PATH, without a vcpkg toolchain.
run("${CMAKE_COMMAND}" --fresh -S "${root}/tests/consumer" -B "${output}/consumer"
  "-DCMAKE_PREFIX_PATH=${prefix}"
  "-DSTAR_RUNTIME_ROOT=${runtime_prefix}"
  ${platform_options})
run("${CMAKE_COMMAND}" --build "${output}/consumer" --config Release)
run("${CMAKE_COMMAND}" --install "${output}/consumer" --config Release
  --prefix "${runtime_prefix}")
run("${CMAKE_CTEST_COMMAND}" --test-dir "${output}/consumer"
  -C Release --output-on-failure)