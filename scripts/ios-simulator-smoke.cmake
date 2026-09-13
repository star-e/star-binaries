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
  # Capture simctl itself; do not attach or redirect the application's console.
  set(launch_log "${log_path}.launch")
  execute_process(COMMAND "${CMAKE_COMMAND}" -E env "SIMCTL_CHILD_STAR_SMOKE_TOKEN=${token}"
    xcrun simctl launch --terminate-running-process "${udid}" "${bundle}"
    TIMEOUT 120 RESULT_VARIABLE launch_result
    OUTPUT_FILE "${launch_log}" ERROR_FILE "${launch_log}")
  file(READ "${launch_log}" launch_output)
  file(APPEND "${log_path}" "Launch (${launch_result}): ${launch_output}\nToken: ${token}\n")

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
  # Record any result even when launch failed, without treating it as a pass.
  if(EXISTS "${result_path}")
    file(READ "${result_path}" report)
    string(STRIP "${report}" report)
  endif()
  file(APPEND "${log_path}" "Completed: ${completed}\nResult: ${report}\n")
  if(NOT launch_result STREQUAL "0" OR NOT completed
      OR NOT report STREQUAL "${token} STAR_IOS_SMOKE_PASSED")
    # Include diagnostics in the existing artifact and in the Actions console.
    execute_process(COMMAND xcrun simctl spawn "${udid}" log show
      --last 2m --style compact
      --predicate "process == 'ios_consumer' OR process == 'SpringBoard' OR process == 'runningboardd'"
      TIMEOUT 20 RESULT_VARIABLE diagnostic_result
      OUTPUT_VARIABLE diagnostic_output ERROR_VARIABLE diagnostic_error)
    file(APPEND "${log_path}"
      "System log (${diagnostic_result}):\n${diagnostic_output}\n${diagnostic_error}\n")
    message(STATUS "Launch (${launch_result}): ${launch_output}\nResult: ${report}")
    message(FATAL_ERROR "Simulator smoke test failed or timed out. "
      "simctl result: ${launch_result}; completed: ${completed}; see ${log_path}")
  endif()
  message(STATUS "${report}")
endfunction()
