cmake_minimum_required(VERSION 3.24)
project(StarBinariesConsumer LANGUAGES CXX)

set(ZLIB_USE_STATIC_LIBS OFF)
find_package(ZLIB REQUIRED)
foreach(dependency_path IN ITEMS "${ZLIB_INCLUDE_DIR}" "${ZLIB_LIBRARY_RELEASE}")
  cmake_path(IS_PREFIX CMAKE_PREFIX_PATH "${dependency_path}" NORMALIZE from_sdk)
  if(NOT from_sdk)
    message(FATAL_ERROR "Dependency resolved outside the SDK: ${dependency_path}")
  endif()
endforeach()
if(APPLE AND NOT ZLIB_LIBRARY_RELEASE MATCHES "\\.dylib$")
  message(FATAL_ERROR "Expected shared zlib, got ${ZLIB_LIBRARY_RELEASE}")
endif()

add_executable(consumer main.cpp)
target_compile_features(consumer PRIVATE cxx_std_20)
target_link_libraries(consumer PRIVATE ZLIB::ZLIB)
if(WIN32)
  find_file(zlib_runtime NAMES z.dll zlib1.dll zlib.dll
    PATHS "${CMAKE_PREFIX_PATH}/bin" NO_DEFAULT_PATH REQUIRED)
  add_custom_command(TARGET consumer POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${zlib_runtime}" $<TARGET_FILE_DIR:consumer>
    VERBATIM)
endif()

enable_testing()
add_test(NAME zlib-consumer COMMAND consumer)
if(DEFINED STAR_RUNTIME_ROOT)
  if(APPLE)
    set_target_properties(consumer PROPERTIES INSTALL_RPATH "@loader_path/../lib")
  endif()
  install(TARGETS consumer RUNTIME DESTINATION bin)
  add_test(NAME zlib-runtime
    COMMAND "${STAR_RUNTIME_ROOT}/bin/consumer${CMAKE_EXECUTABLE_SUFFIX}")
endif()