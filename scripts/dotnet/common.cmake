function(star_dotnet_run directory)
  execute_process(COMMAND ${ARGN} WORKING_DIRECTORY "${directory}"
    COMMAND_ECHO STDOUT COMMAND_ERROR_IS_FATAL ANY)
endfunction()

function(star_dotnet_require_file path)
  if(NOT EXISTS "${path}" OR IS_DIRECTORY "${path}")
    message(FATAL_ERROR "Required .NET artifact is missing: ${path}")
  endif()
endfunction()

function(star_dotnet_acquire_sdk work result)
  file(MAKE_DIRECTORY "${work}/tools")
  file(LOCK "${work}/tools/sdk.lock" GUARD FUNCTION TIMEOUT 0)
  set(archive "${work}/downloads/dotnet-sdk-${STAR_DOTNET_SDK_VERSION}-win-x64.zip")
  set(compiler "${work}/tools/dotnet-sdk-${STAR_DOTNET_SDK_VERSION}")
  if(NOT EXISTS "${compiler}/sdk/${STAR_DOTNET_SDK_VERSION}/dotnet.dll")
    file(MAKE_DIRECTORY "${work}/downloads" "${compiler}")
    if(EXISTS "${archive}")
      file(SHA512 "${archive}" actual_hash)
      if(NOT actual_hash STREQUAL STAR_DOTNET_SDK_SHA512)
        message(FATAL_ERROR "SDK checksum mismatch: ${archive}")
      endif()
    else()
      file(DOWNLOAD "${STAR_DOTNET_SDK_URL}" "${archive}.partial"
        EXPECTED_HASH "SHA512=${STAR_DOTNET_SDK_SHA512}" TLS_VERIFY ON SHOW_PROGRESS)
      file(RENAME "${archive}.partial" "${archive}")
    endif()
    file(ARCHIVE_EXTRACT INPUT "${archive}" DESTINATION "${compiler}")
  endif()
  file(WRITE "${compiler}/global.json"
    "{\"sdk\":{\"version\":\"${STAR_DOTNET_SDK_VERSION}\",\"rollForward\":\"disable\",\"allowPrerelease\":true}}\n")
  execute_process(COMMAND "${CMAKE_COMMAND}" -E env DOTNET_CLI_TELEMETRY_OPTOUT=1
    DOTNET_GENERATE_ASPNET_CERTIFICATE=false DOTNET_ADD_GLOBAL_TOOLS_TO_PATH=false
    "${compiler}/dotnet.exe" --version WORKING_DIRECTORY "${compiler}"
    OUTPUT_VARIABLE actual_version OUTPUT_STRIP_TRAILING_WHITESPACE COMMAND_ERROR_IS_FATAL ANY)
  if(NOT actual_version STREQUAL STAR_DOTNET_SDK_VERSION)
    message(FATAL_ERROR "Unexpected consumer SDK: ${actual_version}")
  endif()
  set(${result} "${compiler}/dotnet.exe" PARENT_SCOPE)
endfunction()
