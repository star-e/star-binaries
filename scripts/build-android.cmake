cmake_minimum_required(VERSION 3.24)

if(NOT TRIPLET MATCHES "^(arm64-android-star|x64-android-star)$")
  message(FATAL_ERROR "Pass -DTRIPLET=arm64-android-star or x64-android-star")
endif()
file(TO_CMAKE_PATH "$ENV{ANDROID_NDK_HOME}" ndk)
if(NOT EXISTS "${ndk}/build/cmake/android.toolchain.cmake")
  message(FATAL_ERROR "Set ANDROID_NDK_HOME to an installed Android NDK")
endif()
find_program(ninja NAMES ninja REQUIRED)
if(DEFINED ANDROID_SERIAL AND NOT ANDROID_SERIAL STREQUAL "")
  find_program(adb NAMES adb REQUIRED)
elseif(TRIPLET STREQUAL "x64-android-star")
  message(FATAL_ERROR "Pass -DANDROID_SERIAL=<booted x86_64 emulator/device serial>")
endif()

get_filename_component(root "${CMAKE_CURRENT_LIST_DIR}/.." ABSOLUTE)
set(ENV{VCPKG_ROOT} "${root}/tools/vcpkg")
function(run)
  execute_process(COMMAND ${ARGV} WORKING_DIRECTORY "${root}"
    COMMAND_ERROR_IS_FATAL ANY)
endfunction()
include("${root}/triplets/${TRIPLET}.cmake")
if(TRIPLET STREQUAL "arm64-android-star")
  set(abi arm64-v8a)
else()
  set(abi x86_64)
endif()
if(adb)
  execute_process(COMMAND "${adb}" -s "${ANDROID_SERIAL}" shell getprop ro.product.cpu.abi
    TIMEOUT 30 OUTPUT_VARIABLE device_abi OUTPUT_STRIP_TRAILING_WHITESPACE
    COMMAND_ERROR_IS_FATAL ANY)
  execute_process(COMMAND "${adb}" -s "${ANDROID_SERIAL}" shell getprop ro.build.version.sdk
    TIMEOUT 30 OUTPUT_VARIABLE device_api OUTPUT_STRIP_TRAILING_WHITESPACE
    COMMAND_ERROR_IS_FATAL ANY)
  if(NOT device_abi STREQUAL abi OR NOT device_api MATCHES "^[0-9]+$"
      OR device_api LESS VCPKG_CMAKE_SYSTEM_VERSION)
    message(FATAL_ERROR "Device must use ${abi} and API ${VCPKG_CMAKE_SYSTEM_VERSION} or newer")
  endif()
endif()

file(READ "${root}/vcpkg.json" manifest)
string(JSON baseline GET "${manifest}" builtin-baseline)
execute_process(COMMAND git -C "${root}/tools/vcpkg" rev-parse HEAD
  OUTPUT_VARIABLE revision OUTPUT_STRIP_TRAILING_WHITESPACE
  COMMAND_ERROR_IS_FATAL ANY)
if(NOT revision STREQUAL baseline)
  message(FATAL_ERROR "vcpkg submodule and builtin-baseline must match")
endif()
execute_process(COMMAND git -C "${root}" rev-parse HEAD
  OUTPUT_VARIABLE source_revision OUTPUT_STRIP_TRAILING_WHITESPACE
  COMMAND_ERROR_IS_FATAL ANY)
file(READ "${ndk}/source.properties" ndk_version)

set(output "${root}/out/${TRIPLET}")
if(CMAKE_HOST_WIN32)
  run(cmd /c "${root}/tools/vcpkg/bootstrap-vcpkg.bat" -disableMetrics)
  set(vcpkg "${root}/tools/vcpkg/vcpkg.exe")
else()
  run(bash "${root}/tools/vcpkg/bootstrap-vcpkg.sh" -disableMetrics)
  set(vcpkg "${root}/tools/vcpkg/vcpkg")
endif()
run("${vcpkg}" install "--triplet=${TRIPLET}"
  "--x-manifest-root=${root}" "--x-install-root=${output}/installed")
set(installed "${output}/installed/${TRIPLET}")
set(base "star-binaries-${TRIPLET}-sdk")
set(sdk "${output}/${base}")
set(archive "${output}/${base}.zip")
set(relocated "${output}/relocated")
file(REMOVE_RECURSE "${sdk}" "${relocated}")
file(REMOVE "${archive}" "${archive}.sha256")
file(MAKE_DIRECTORY "${sdk}")
file(COPY "${installed}/" DESTINATION "${sdk}"
  PATTERN "*.pdb" EXCLUDE PATTERN "*.dSYM" EXCLUDE)
file(REMOVE_RECURSE "${sdk}/share/doc" "${sdk}/share/man")
file(GLOB_RECURSE dynamic_libraries "${sdk}/*.dylib" "${sdk}/*.so" "${sdk}/*.so.*" "${sdk}/*.dll")
if(dynamic_libraries)
  message(FATAL_ERROR "Unexpected dynamic libraries in static Android SDK")
endif()
file(COPY "${root}/vcpkg.json" "${root}/vcpkg-configuration.json"
  "${root}/triplets" DESTINATION "${sdk}/provenance")
file(WRITE "${sdk}/provenance/build.txt"
  "source=${source_revision}\nvcpkg=${revision}\ntriplet=${TRIPLET}\nconfigurations=Release,Debug\nlinkage=static\nstl=c++_static\nabi=${abi}\napi=${VCPKG_CMAKE_SYSTEM_VERSION}\ncmake=${CMAKE_VERSION}\nhost=${CMAKE_HOST_SYSTEM}\n${ndk_version}")
execute_process(COMMAND "${CMAKE_COMMAND}" -E tar cf "${archive}"
  --format=zip "${base}" WORKING_DIRECTORY "${output}"
  COMMAND_ERROR_IS_FATAL ANY)
file(ARCHIVE_EXTRACT INPUT "${archive}" DESTINATION "${relocated}")

foreach(configuration Release Debug)
  string(TOLOWER "${configuration}" config_name)
  set(consumer_build "${output}/consumer-${config_name}")
  run("${CMAKE_COMMAND}" --fresh -G Ninja -S "${root}/tests/android" -B "${consumer_build}"
    "-DCMAKE_MAKE_PROGRAM=${ninja}"
    "-DCMAKE_TOOLCHAIN_FILE=${ndk}/build/cmake/android.toolchain.cmake"
    "-DANDROID_ABI=${abi}" "-DANDROID_PLATFORM=android-${VCPKG_CMAKE_SYSTEM_VERSION}"
    -DANDROID_STL=c++_static "-DCMAKE_BUILD_TYPE=${configuration}"
    "-DCMAKE_PREFIX_PATH=${relocated}/${base}")
  run("${CMAKE_COMMAND}" --build "${consumer_build}" --config "${configuration}")
  if(adb)
    set(remote "/data/local/tmp/star-binaries-${TRIPLET}-${config_name}")
    run("${adb}" -s "${ANDROID_SERIAL}" push "${consumer_build}/android_consumer" "${remote}")
    run("${adb}" -s "${ANDROID_SERIAL}" shell chmod 700 "${remote}")
    execute_process(COMMAND "${adb}" -s "${ANDROID_SERIAL}" shell "${remote}"
      TIMEOUT 120 RESULT_VARIABLE test_result
      OUTPUT_VARIABLE test_output ERROR_VARIABLE test_error)
    file(WRITE "${output}/${config_name}-android.log" "${test_output}\n${test_error}")
    message(STATUS "${test_output}\n${test_error}")
    run("${adb}" -s "${ANDROID_SERIAL}" shell rm -f "${remote}")
    set(transcript "${test_output}\n${test_error}")
    if(NOT test_result STREQUAL "0" OR NOT transcript MATCHES "STAR_ANDROID_SMOKE_PASSED"
        OR transcript MATCHES "STAR_ANDROID_SMOKE_FAILED")
      message(FATAL_ERROR "${configuration} Android smoke test failed: ${test_result}; see ${output}/${config_name}-android.log")
    endif()
  endif()
endforeach()

file(SHA256 "${archive}" checksum)
file(WRITE "${archive}.sha256" "${checksum}  ${base}.zip\n")
