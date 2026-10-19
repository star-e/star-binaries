cmake_minimum_required(VERSION 3.24)
if(NOT DEFINED TEST_ROOT)
  message(FATAL_ERROR "Pass -DTEST_ROOT=<scratch directory>")
endif()
file(MAKE_DIRECTORY "${TEST_ROOT}/sdk/share/boost" "${TEST_ROOT}/sysroot"
  "${TEST_ROOT}/sdk/include" "${TEST_ROOT}/sdk/lib" "${TEST_ROOT}/sdk/debug/lib"
  "${TEST_ROOT}/fixture")
file(WRITE "${TEST_ROOT}/sdk/share/boost/BoostConfig.cmake"
  "set(STAR_LOOKUP_FIXTURE_FOUND TRUE)\n")
set(CMAKE_FIND_ROOT_PATH "${TEST_ROOT}/sysroot")
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
find_package(Boost CONFIG QUIET PATHS "${TEST_ROOT}/sdk/share/boost" NO_DEFAULT_PATH)
if(Boost_FOUND)
  message(FATAL_ERROR "Expected lookup without NO_CMAKE_FIND_ROOT_PATH to fail")
endif()

# Configure the real shared consumer helper against a synthetic static SDK.
file(WRITE "${TEST_ROOT}/sdk/lib/container.lib" "fixture")
file(WRITE "${TEST_ROOT}/sdk/debug/lib/container.lib" "fixture")
file(WRITE "${TEST_ROOT}/sdk/share/boost/BoostConfigVersion.cmake" "
set(PACKAGE_VERSION 1.92.0)
set(PACKAGE_VERSION_COMPATIBLE TRUE)
")
file(WRITE "${TEST_ROOT}/sdk/share/boost/BoostConfig.cmake" "
add_library(Boost::container STATIC IMPORTED)
set_target_properties(Boost::container PROPERTIES
  IMPORTED_CONFIGURATIONS \"RELEASE;DEBUG\"
  IMPORTED_LOCATION_RELEASE \"${TEST_ROOT}/sdk/lib/container.lib\"
  IMPORTED_LOCATION_DEBUG \"${TEST_ROOT}/sdk/debug/lib/container.lib\"
  INTERFACE_INCLUDE_DIRECTORIES \"${TEST_ROOT}/sdk/include\")
add_library(Boost::unordered INTERFACE IMPORTED)
add_library(Boost::dynamic_bitset INTERFACE IMPORTED)
")
file(WRITE "${TEST_ROOT}/fixture/main.cpp" "int main() { return 0; }\n")
file(WRITE "${TEST_ROOT}/fixture/CMakeLists.txt" "
cmake_minimum_required(VERSION 3.24)
project(StaticSDKLookup LANGUAGES CXX)
set(CMAKE_FIND_ROOT_PATH \"${TEST_ROOT}/sysroot\")
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
include(\"${CMAKE_CURRENT_LIST_DIR}/boost.cmake\")
add_executable(consumer main.cpp)
star_test_boost(consumer \"${TEST_ROOT}/sdk\" STATIC_LIBRARY \"\${STAR_CONFIGURATION}\")
")
foreach(configuration Release Debug)
  execute_process(COMMAND "${CMAKE_COMMAND}" --fresh
    "-DSTAR_CONFIGURATION=${configuration}"
    -S "${TEST_ROOT}/fixture" -B "${TEST_ROOT}/fixture-build"
    COMMAND_ERROR_IS_FATAL ANY)
endforeach()
message(STATUS "Root-only lookup and Boost.Container static SDK checks passed")
