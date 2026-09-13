cmake_minimum_required(VERSION 3.24)

if(NOT DEFINED TEST_ROOT)
  message(FATAL_ERROR "Pass -DTEST_ROOT=<scratch directory>")
endif()
file(MAKE_DIRECTORY "${TEST_ROOT}/sdk/share/zlib" "${TEST_ROOT}/sysroot")
file(WRITE "${TEST_ROOT}/sdk/share/zlib/ZLIBConfig.cmake"
  "set(STAR_LOOKUP_FIXTURE_FOUND TRUE)\n")
set(CMAKE_PREFIX_PATH "${TEST_ROOT}/sdk")
set(CMAKE_FIND_ROOT_PATH "${TEST_ROOT}/sysroot")
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
find_package(ZLIB CONFIG QUIET PATHS "${CMAKE_PREFIX_PATH}/share/zlib" NO_DEFAULT_PATH)
if(ZLIB_FOUND)
  message(FATAL_ERROR "Expected the original lookup to fail under root-only searching")
endif()

file(READ "${CMAKE_CURRENT_LIST_DIR}/CMakeLists.txt" consumer)
string(REGEX MATCH "find_package\\(ZLIB[^)]+\\)" lookup "${consumer}")
if(NOT lookup)
  message(FATAL_ERROR "Could not locate consumer package lookup")
endif()
cmake_language(EVAL CODE "${lookup}")
if(NOT ZLIB_FOUND OR NOT STAR_LOOKUP_FIXTURE_FOUND)
  message(FATAL_ERROR "Consumer did not find the explicit SDK config")
endif()
message(STATUS "Original root-only lookup failed; Android consumer SDK lookup passed")

file(MAKE_DIRECTORY "${TEST_ROOT}/sdk/include" "${TEST_ROOT}/sdk/lib" "${TEST_ROOT}/sdk/debug/lib"
  "${TEST_ROOT}/fixture")
file(WRITE "${TEST_ROOT}/sdk/lib/libz.a" "fixture")
file(WRITE "${TEST_ROOT}/sdk/debug/lib/libz.a" "fixture")
file(WRITE "${TEST_ROOT}/sdk/share/zlib/ZLIBConfig.cmake" "
if(NOT ZLIB_FIND_COMPONENTS STREQUAL \"static\")
  message(FATAL_ERROR \"Consumer must request static zlib\")
endif()
add_library(ZLIB::ZLIBSTATIC STATIC IMPORTED)
set_target_properties(ZLIB::ZLIBSTATIC PROPERTIES
  IMPORTED_LOCATION_RELEASE \"${TEST_ROOT}/sdk/lib/libz.a\"
  IMPORTED_LOCATION_DEBUG \"${TEST_ROOT}/sdk/debug/lib/libz.a\"
  INTERFACE_INCLUDE_DIRECTORIES \"${TEST_ROOT}/sdk/include\")
")
string(FIND "${consumer}" "find_package(ZLIB" lookup_start)
string(FIND "${consumer}" "add_executable(" lookup_end)
math(EXPR lookup_length "${lookup_end} - ${lookup_start}")
string(SUBSTRING "${consumer}" ${lookup_start} ${lookup_length} validation)
file(WRITE "${TEST_ROOT}/fixture/CMakeLists.txt" "
cmake_minimum_required(VERSION 3.24)
project(StaticSDKLookup NONE)
set(CMAKE_PREFIX_PATH \"${TEST_ROOT}/sdk\")
set(CMAKE_FIND_ROOT_PATH \"${TEST_ROOT}/sysroot\")
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
${validation}
")
foreach(configuration Release Debug)
  execute_process(COMMAND "${CMAKE_COMMAND}" --fresh
    "-DCMAKE_BUILD_TYPE=${configuration}"
    -S "${TEST_ROOT}/fixture" -B "${TEST_ROOT}/fixture-build"
    COMMAND_ERROR_IS_FATAL ANY)
endforeach()
message(STATUS "Consumer static target and SDK property checks passed")
