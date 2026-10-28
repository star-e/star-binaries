cmake_minimum_required(VERSION 3.26)
get_filename_component(root "${CMAKE_CURRENT_LIST_DIR}/../.." ABSOLUTE)
file(MAKE_DIRECTORY "${BUILD_DIR}")
file(READ "${root}/scripts/dotnet/profiles/base.json" profile)

function(expect_rejection diagnostic)
  execute_process(COMMAND "${DOTNET_EXECUTABLE}" "${PROFILE_TOOL}" ${ARGN}
    RESULT_VARIABLE result OUTPUT_VARIABLE output ERROR_VARIABLE error)
  if(result EQUAL 0 OR NOT "${output}${error}" MATCHES "${diagnostic}")
    message(FATAL_ERROR "Expected ${diagnostic}; exit ${result}:\n${output}${error}")
  endif()
endfunction()

# Exclusions must also apply to dependencies, not only explicitly selected roots.
string(JSON count LENGTH "${profile}" excludedManagedPatterns)
string(JSON excluded SET "${profile}" excludedManagedPatterns ${count} "\"System.Private.Uri\"")
file(WRITE "${BUILD_DIR}/excluded.json" "${excluded}")
expect_rejection("Excluded dependency: System.Private.Uri" pack
  "${BUILD_DIR}/excluded.json" "${SOURCE_SDK}" "${BUILD_DIR}/excluded-sdk")
if(EXISTS "${BUILD_DIR}/excluded-sdk")
  message(FATAL_ERROR "Excluded dependency produced a partial SDK")
endif()

string(JSON count LENGTH "${profile}" managedRoots core)
string(JSON missing SET "${profile}" managedRoots core ${count} "\"Star.DotNet.MissingRoot\"")
file(WRITE "${BUILD_DIR}/missing.json" "${missing}")
expect_rejection("Missing assembly: .*Star.DotNet.MissingRoot.dll" pack
  "${BUILD_DIR}/missing.json" "${SOURCE_SDK}" "${BUILD_DIR}/missing-sdk")

string(JSON mismatch SET "${profile}" sourceRevision "\"0000000000000000000000000000000000000000\"")
file(WRITE "${BUILD_DIR}/mismatch.json" "${mismatch}")
expect_rejection("Profile revision differs from input SDK" pack
  "${BUILD_DIR}/mismatch.json" "${SOURCE_SDK}" "${BUILD_DIR}/mismatch-sdk")

file(MAKE_DIRECTORY "${BUILD_DIR}/incomplete-plugin")
file(COPY "${APPLICATIONS}/plugin/Star.DotNet.Plugin.dll" DESTINATION "${BUILD_DIR}/incomplete-plugin")
expect_rejection("Missing application dependency: Star.DotNet.Plugin -> Star.DotNet.PluginDependency" check-app
  "${SELECTED_SDK}" "${BUILD_DIR}/incomplete-plugin")
message(STATUS "Profile selection rejection checks passed (4)")
