# The app writes an atomic, per-launch acknowledgement in its data container.
# A successful simctl launch only confirms process creation, not test completion.
function(star_run_ios_smoke udid log_path)
  set(bundle org.star-engine.binaries.smoke)
  file(WRITE "${log_path}" "Simulator: ${udid}\n")
  execute_process(COMMAND xcrun simctl get_app_container "${udid}" "${bundle}" data
    TIMEOUT 30 RESULT_VARIABLE container_result
    OUTPUT_VARIABLE container ERROR_VARIABLE container_error
    OUTPUT_STRIP_TRAILING_WHITESPACE)
  file(APPEND "${log_path}" "Container (${container_result}): ${container}\n${container_error}\n")
  if(NOT container_result STREQUAL "0" OR NOT IS_DIRECTORY "${container}")
    message(FATAL_ERROR "Cannot locate simulator app data; see ${log_path}")
  endif()

  string(RANDOM LENGTH 32 ALPHABET 0123456789abcdef token)
  set(result_path "${container}/Documents/star-smoke-result.txt")
  set(stdout_path "${log_path}.stdout")
  set(stderr_path "${log_path}.stderr")
  file(WRITE "${stdout_path}" "")
  file(WRITE "${stderr_path}" "")
  execute_process(COMMAND "${CMAKE_COMMAND}" -E env "SIMCTL_CHILD_STAR_SMOKE_TOKEN=${token}"
    xcrun simctl launch --terminate-running-process
    "--stdout=${stdout_path}" "--stderr=${stderr_path}" "${udid}" "${bundle}"
    TIMEOUT 30 RESULT_VARIABLE launch_result
    OUTPUT_VARIABLE launch_output ERROR_VARIABLE launch_error)
  file(APPEND "${log_path}" "Launch (${launch_result}): ${launch_output}\n${launch_error}\nToken: ${token}\n")

  set(report "")
  set(completed FALSE)
  if(launch_result STREQUAL "0")
    foreach(attempt RANGE 0 120)
      if(EXISTS "${result_path}")
        file(READ "${result_path}" report)
        string(STRIP "${report}" report)
        # Ignore an earlier Release/Debug run's result, even if it passed.
        if(report MATCHES "^${token} STAR_IOS_SMOKE_(PASSED|FAILED)$")
          set(completed TRUE)
          break()
        endif()
      endif()
      if(attempt LESS 120)
        execute_process(COMMAND "${CMAKE_COMMAND}" -E sleep 1)
      endif()
    endforeach()
  endif()

  # Best effort cleanup also stops an app that hung or never wrote a result.
  execute_process(COMMAND xcrun simctl terminate "${udid}" "${bundle}"
    TIMEOUT 10 OUTPUT_QUIET ERROR_QUIET)
  foreach(stream IN ITEMS "${stdout_path}" "${stderr_path}")
    if(EXISTS "${stream}")
      file(READ "${stream}" transcript)
      file(APPEND "${log_path}" "${stream}:\n${transcript}\n")
    endif()
  endforeach()
  file(APPEND "${log_path}" "Completed: ${completed}\nResult: ${report}\n")
  if(NOT launch_result STREQUAL "0" OR NOT completed
      OR NOT report STREQUAL "${token} STAR_IOS_SMOKE_PASSED")
    message(FATAL_ERROR "Simulator smoke test failed or timed out. "
      "simctl result: ${launch_result}; completed: ${completed}; see ${log_path}")
  endif()
  message(STATUS "${report}")
endfunction()
