cmake_minimum_required(VERSION 3.24)
project(StarBinariesIOSConsumer LANGUAGES CXX OBJCXX)

if(NOT CMAKE_SYSTEM_NAME STREQUAL "iOS")
  message(FATAL_ERROR "This consumer requires an iOS toolchain")
endif()
if(NOT STAR_CONFIGURATION MATCHES "^(Release|Debug)$")
  message(FATAL_ERROR "Pass STAR_CONFIGURATION=Release or Debug")
endif()
find_package(ZLIB CONFIG REQUIRED PATHS "${CMAKE_PREFIX_PATH}/share/zlib" NO_DEFAULT_PATH)
string(TOUPPER "${STAR_CONFIGURATION}" configuration_upper)
get_target_property(selected_library ZLIB::ZLIB "IMPORTED_LOCATION_${configuration_upper}")
get_target_property(include_paths ZLIB::ZLIB INTERFACE_INCLUDE_DIRECTORIES)
get_target_property(library_type ZLIB::ZLIB TYPE)
if(NOT library_type STREQUAL "STATIC_LIBRARY" OR NOT EXISTS "${selected_library}")
  message(FATAL_ERROR "Missing static zlib for ${STAR_CONFIGURATION}")
endif()
foreach(dependency_path IN ITEMS ${include_paths} "${selected_library}")
  cmake_path(IS_PREFIX CMAKE_PREFIX_PATH "${dependency_path}" NORMALIZE from_sdk)
  if(NOT from_sdk)
    message(FATAL_ERROR "Dependency resolved outside the SDK: ${dependency_path}")
  endif()
endforeach()

add_executable(ios_consumer MACOSX_BUNDLE main.mm ../consumer/main.cpp)
set_source_files_properties(../consumer/main.cpp PROPERTIES
  COMPILE_DEFINITIONS "main=star_zlib_roundtrip")
target_compile_features(ios_consumer PRIVATE cxx_std_20)
target_compile_options(ios_consumer PRIVATE "$<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>")
target_link_libraries(ios_consumer PRIVATE ZLIB::ZLIB "-framework UIKit")
set_target_properties(ios_consumer PROPERTIES
  MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/Info.plist.in"
  MACOSX_BUNDLE_GUI_IDENTIFIER "org.star-engine.binaries.smoke"
  XCODE_ATTRIBUTE_CODE_SIGNING_ALLOWED "NO"
  XCODE_ATTRIBUTE_TARGETED_DEVICE_FAMILY "1,2")