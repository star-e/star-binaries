function(star_v8_linkage result)
  if(TRIPLET MATCHES "-ios(-simulator)?-star$")
    set(${result} STATIC PARENT_SCOPE)
  else()
    set(${result} SHARED PARENT_SCOPE)
  endif()
endfunction()

function(star_v8_args configuration result)
  set(args "is_component_build=true
v8_monolithic=false
v8_enable_pointer_compression=true
v8_enable_sandbox=true
v8_use_external_startup_data=false
v8_generate_external_defines_header=true
v8_enable_i18n_support=true
icu_use_data_file=false
use_custom_libcxx=false
use_custom_libcxx_for_host=false
is_clang=true
use_remoteexec=false
use_siso=false
use_thin_lto=false
treat_warnings_as_errors=false
symbol_level=1
v8_enable_gdbjit=false
")
  star_v8_linkage(linkage)
  if(linkage STREQUAL "STATIC")
    string(REPLACE "is_component_build=true" "is_component_build=false" args "${args}")
    string(REPLACE "v8_monolithic=false" "v8_monolithic=true" args "${args}")
  endif()
  if(configuration STREQUAL "Debug")
    string(APPEND args "is_debug=true\nenable_iterator_debugging=true\n")
  else()
    string(APPEND args "is_debug=false\nenable_iterator_debugging=false\n")
  endif()
  if(TRIPLET MATCHES "^x64-")
    string(APPEND args "target_cpu=\"x64\"\n")
  else()
    string(APPEND args "target_cpu=\"arm64\"\n")
  endif()
  if(TRIPLET STREQUAL "x64-windows-star")
    string(APPEND args "target_os=\"win\"\n")
  elseif(TRIPLET STREQUAL "arm64-osx-star")
    string(APPEND args "target_os=\"mac\"\nmac_deployment_target=\"13.0\"\n")
  elseif(TRIPLET MATCHES "-android-star$")
    # Host snapshot/torque tools use Chromium's matching libc++; the Android
    # library itself uses the NDK's libc++ ABI shared with downstream consumers.
    string(REPLACE "use_custom_libcxx_for_host=false" "use_custom_libcxx_for_host=true" args "${args}")
    string(APPEND args "target_os=\"android\"\nandroid64_ndk_api_level=28\nandroid32_ndk_api_level=28\nandroid_ndk_root=\"${ndk}\"\nandroid_ndk_version=\"r30\"\n")
  elseif(TRIPLET MATCHES "-ios(-simulator)?-star$")
    string(APPEND args "target_os=\"ios\"\nios_deployment_target=\"15.0\"\nios_enable_code_signing=false\nv8_enable_lite_mode=true\nv8_jitless=true\nv8_enable_webassembly=false\n")
    if(TRIPLET STREQUAL "arm64-ios-simulator-star")
      string(APPEND args "target_environment=\"simulator\"\n")
    else()
      string(APPEND args "target_environment=\"device\"\n")
    endif()
  else()
    message(FATAL_ERROR "Unsupported V8 triplet: ${TRIPLET}")
  endif()
  set(${result} "${args}" PARENT_SCOPE)
endfunction()
