cmake_minimum_required(VERSION 3.24)
project(StarBinariesConsumer LANGUAGES CXX)

if(NOT DEFINED STAR_CONFIGURATION)
  set(STAR_CONFIGURATION Release)
endif()
if(NOT STAR_CONFIGURATION MATCHES "^(Release|Debug)$")
  message(FATAL_ERROR "Unsupported test configuration: ${STAR_CONFIGURATION}")
endif()
add_executable(consumer main.cpp)
target_compile_features(consumer PRIVATE cxx_std_20)
include(boost.cmake)
star_test_boost(consumer "${CMAKE_PREFIX_PATH}" SHARED_LIBRARY "${STAR_CONFIGURATION}")
include(stdexec.cmake)
star_test_stdexec(consumer "${CMAKE_PREFIX_PATH}")
include(gsl.cmake)
star_test_gsl(consumer "${CMAKE_PREFIX_PATH}")
if(WIN32)
  add_custom_command(TARGET consumer POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      $<TARGET_RUNTIME_DLLS:consumer> $<TARGET_FILE_DIR:consumer>
    COMMAND_EXPAND_LISTS VERBATIM)
endif()

enable_testing()
add_test(NAME dependencies.consumer COMMAND consumer)
if(DEFINED STAR_RUNTIME_ROOT)
  if(APPLE)
    set_target_properties(consumer PROPERTIES INSTALL_RPATH "@loader_path/../lib")
  endif()
  install(TARGETS consumer RUNTIME DESTINATION bin)
  add_test(NAME dependencies.runtime
    COMMAND "${STAR_RUNTIME_ROOT}/bin/consumer${CMAKE_EXECUTABLE_SUFFIX}")
endif()
