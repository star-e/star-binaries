cmake_minimum_required(VERSION 3.24)
project(StarBinariesIOSConsumer LANGUAGES CXX OBJCXX)

if(NOT CMAKE_SYSTEM_NAME STREQUAL "iOS")
  message(FATAL_ERROR "This consumer requires an iOS toolchain")
endif()
if(NOT STAR_CONFIGURATION MATCHES "^(Release|Debug)$")
  message(FATAL_ERROR "Pass STAR_CONFIGURATION=Release or Debug")
endif()
add_executable(ios_consumer MACOSX_BUNDLE main.mm ../consumer/main.cpp)
set_source_files_properties(../consumer/main.cpp PROPERTIES
  COMPILE_DEFINITIONS "main=star_smoke_main")
target_compile_features(ios_consumer PRIVATE cxx_std_20)
target_compile_options(ios_consumer PRIVATE "$<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>")
target_link_libraries(ios_consumer PRIVATE "-framework UIKit")
include(../consumer/boost.cmake)
star_test_boost(ios_consumer "${CMAKE_PREFIX_PATH}" STATIC_LIBRARY "${STAR_CONFIGURATION}")
include(../consumer/stdexec.cmake)
star_test_stdexec(ios_consumer "${CMAKE_PREFIX_PATH}")
include(../consumer/gsl.cmake)
star_test_gsl(ios_consumer "${CMAKE_PREFIX_PATH}")
set_target_properties(ios_consumer PROPERTIES
  MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/Info.plist.in"
  MACOSX_BUNDLE_GUI_IDENTIFIER "org.star-engine.binaries.smoke"
  XCODE_ATTRIBUTE_PRODUCT_BUNDLE_IDENTIFIER "org.star-engine.binaries.smoke"
  XCODE_ATTRIBUTE_CODE_SIGNING_ALLOWED "NO"
  XCODE_ATTRIBUTE_TARGETED_DEVICE_FAMILY "1,2")
