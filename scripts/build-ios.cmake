cmake_minimum_required(VERSION 3.24)

if(NOT TRIPLET MATCHES "^(arm64-ios-star|arm64-ios-simulator-star)$")
  message(FATAL_ERROR "Pass -DTRIPLET=arm64-ios-star or arm64-ios-simulator-star")
endif()
if(NOT CMAKE_HOST_APPLE)
  message(FATAL_ERROR "iOS builds require macOS and full Xcode")
endif()
if(TRIPLET STREQUAL "arm64-ios-simulator-star" AND NOT DEFINED SIMULATOR_UDID)
  message(FATAL_ERROR "Pass -DSIMULATOR_UDID=<booted simulator UUID>")
endif()

get_filename_component(root "${CMAKE_CURRENT_LIST_DIR}/.." ABSOLUTE)
set(ENV{VCPKG_ROOT} "${root}/tools/vcpkg")
function(run)
  execute_process(COMMAND ${ARGV} WORKING_DIRECTORY "${root}"
    COMMAND_ERROR_IS_FATAL ANY)
endfunction()

file(READ "${root}/vcpkg.json" manifest)
string(JSON baseline GET "${manifest}" builtin-baseline)
execute_process(COMMAND git -C "${root}/tools/vcpkg" rev-parse HEAD
  OUTPUT_VARIABLE revision OUTPUT_STRIP_TRAILING_WHITESPACE
  COMMAND_ERROR_IS_FATAL ANY)
if(NOT revision STREQUAL baseline)
  message(FATAL_ERROR "vcpkg submodule and builtin-baseline must match")
endif()
include("${root}/triplets/${TRIPLET}.cmake")
run(xcrun --sdk "${VCPKG_OSX_SYSROOT}" --show-sdk-path)
execute_process(COMMAND xcodebuild -version OUTPUT_VARIABLE xcode_version
  COMMAND_ERROR_IS_FATAL ANY)
execute_process(COMMAND git -C "${root}" rev-parse HEAD
  OUTPUT_VARIABLE source_revision OUTPUT_STRIP_TRAILING_WHITESPACE
  COMMAND_ERROR_IS_FATAL ANY)

set(output "${root}/out/${TRIPLET}")
run(bash "${root}/tools/vcpkg/bootstrap-vcpkg.sh" -disableMetrics)
run("${root}/tools/vcpkg/vcpkg" install "--triplet=${TRIPLET}"
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
file(GLOB_RECURSE dynamic_libraries "${sdk}/*.dylib" "${sdk}/*.so" "${sdk}/*.dll")
if(dynamic_libraries)
  message(FATAL_ERROR "Unexpected dynamic libraries in static iOS SDK")
endif()
file(COPY "${root}/vcpkg.json" "${root}/vcpkg-configuration.json"
  "${root}/triplets" DESTINATION "${sdk}/provenance")
file(WRITE "${sdk}/provenance/build.txt"
  "source=${source_revision}\nvcpkg=${revision}\ntriplet=${TRIPLET}\nconfigurations=Release,Debug\nlinkage=static\nsysroot=${VCPKG_OSX_SYSROOT}\ndeployment_target=${VCPKG_OSX_DEPLOYMENT_TARGET}\ncmake=${CMAKE_VERSION}\n${xcode_version}")
execute_process(COMMAND "${CMAKE_COMMAND}" -E tar cf "${archive}"
  --format=zip "${base}" WORKING_DIRECTORY "${output}"
  COMMAND_ERROR_IS_FATAL ANY)
file(ARCHIVE_EXTRACT INPUT "${archive}" DESTINATION "${relocated}")

foreach(configuration Release Debug)
  string(TOLOWER "${configuration}" config_name)
  set(consumer_build "${output}/consumer-${config_name}")
  run("${CMAKE_COMMAND}" --fresh -G Xcode -S "${root}/tests/ios" -B "${consumer_build}"
    -DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_ARCHITECTURES=arm64
    "-DCMAKE_OSX_SYSROOT=${VCPKG_OSX_SYSROOT}"
    "-DCMAKE_OSX_DEPLOYMENT_TARGET=${VCPKG_OSX_DEPLOYMENT_TARGET}"
    -DCMAKE_XCODE_ATTRIBUTE_CODE_SIGNING_ALLOWED=NO
    "-DCMAKE_PREFIX_PATH=${relocated}/${base}"
    "-DSTAR_CONFIGURATION=${configuration}")
  run("${CMAKE_COMMAND}" --build "${consumer_build}" --config "${configuration}")
  if(TRIPLET STREQUAL "arm64-ios-simulator-star")
    set(app "${consumer_build}/${configuration}-iphonesimulator/ios_consumer.app")
    run(xcrun simctl install "${SIMULATOR_UDID}" "${app}")
    execute_process(COMMAND xcrun simctl launch --console-pty --terminate-running-process
      "${SIMULATOR_UDID}" org.star-engine.binaries.smoke
      TIMEOUT 120 RESULT_VARIABLE launch_result
      OUTPUT_VARIABLE launch_output ERROR_VARIABLE launch_error)
    file(WRITE "${output}/${config_name}-simulator.log" "${launch_output}\n${launch_error}")
    message(STATUS "${launch_output}\n${launch_error}")
    set(launch_transcript "${launch_output}\n${launch_error}")
    if(NOT launch_result STREQUAL "0" OR NOT launch_transcript MATCHES "STAR_IOS_SMOKE_PASSED"
        OR launch_transcript MATCHES "STAR_IOS_SMOKE_FAILED")
      message(FATAL_ERROR
        "${configuration} simulator smoke test did not complete successfully. "
        "simctl result: ${launch_result}; see ${output}/${config_name}-simulator.log")
    endif()
  endif()
endforeach()

file(SHA256 "${archive}" checksum)
file(WRITE "${archive}.sha256" "${checksum}  ${base}.zip\n")