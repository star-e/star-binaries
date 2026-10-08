# Long builds may outlive the simulator process. Prepare it at installation time.
function(star_install_ios_smoke udid app_path log_path)
  file(WRITE "${log_path}" "Simulator: ${udid}\nApp: ${app_path}\n")
  # -b boots a shutdown device; bootstatus also waits for an existing boot.
  execute_process(COMMAND xcrun simctl bootstatus "${udid}" -b
    TIMEOUT 300 RESULT_VARIABLE boot_result
    OUTPUT_VARIABLE boot_output ERROR_VARIABLE boot_error)
  file(APPEND "${log_path}" "Boot (${boot_result}):\n${boot_output}\n${boot_error}\n")
  if(NOT boot_result STREQUAL "0")
    message(FATAL_ERROR "Simulator did not become ready: ${boot_output}\n${boot_error}\nSee ${log_path}")
  endif()
  execute_process(COMMAND xcrun simctl install "${udid}" "${app_path}"
    TIMEOUT 120 RESULT_VARIABLE install_result
    OUTPUT_VARIABLE install_output ERROR_VARIABLE install_error)
  file(APPEND "${log_path}" "Install (${install_result}):\n${install_output}\n${install_error}\n")
  if(NOT install_result STREQUAL "0")
    message(FATAL_ERROR "Simulator app installation failed: ${install_output}\n${install_error}\nSee ${log_path}")
  endif()
endfunction()

# The app writes an atomic, per-launch acknowledgement in its data container.
# A successful simctl launch only confirms process creation, not test completion.
function(star_run_ios_smoke udid log_path)
  set(bundle org.star-engine.binaries.smoke)
  file(WRITE "${log_path}" "Simulator: ${udid}\n")
  # CoreSimulator's container service can stall after the first boot/install.
  # Retry a timeout once; permanent errors must remain visible and fail promptly.
  foreach(container_attempt RANGE 1 2)
    execute_process(COMMAND xcrun simctl get_app_container "${udid}" "${bundle}" data
      TIMEOUT 120 RESULT_VARIABLE container_result
      OUTPUT_VARIABLE container ERROR_VARIABLE container_error
      OUTPUT_STRIP_TRAILING_WHITESPACE)
    set(container_diagnostic "Container attempt ${container_attempt}/2 (${container_result}): ${container}\n${container_error}\n")
    file(APPEND "${log_path}" "${container_diagnostic}")
    message(STATUS "${container_diagnostic}")
    if(NOT container_result MATCHES "[Tt]imeout" OR container_attempt EQUAL 2)
      break()
    endif()
    execute_process(COMMAND "${CMAKE_COMMAND}" -E sleep 5)
  endforeach()
  if(NOT container_result STREQUAL "0" OR NOT IS_DIRECTORY "${container}")
    message(FATAL_ERROR "Cannot locate simulator app data: ${container_diagnostic}See ${log_path}")
  endif()

  string(RANDOM LENGTH 32 ALPHABET 0123456789abcdef token)
  set(result_path "${container}/Documents/star-smoke-result.txt")
  # Capture simctl itself; do not attach or redirect the application's console.
  set(launch_log "${log_path}.launch")
  string(TIMESTAMP launch_started "%Y-%m-%dT%H:%M:%SZ" UTC)
  file(APPEND "${log_path}" "Launch started: ${launch_started}\n")
  execute_process(COMMAND "${CMAKE_COMMAND}" -E env "SIMCTL_CHILD_STAR_SMOKE_TOKEN=${token}"
    xcrun simctl launch --terminate-running-process "${udid}" "${bundle}"
    TIMEOUT 120 RESULT_VARIABLE launch_result
    OUTPUT_FILE "${launch_log}" ERROR_FILE "${launch_log}")
  file(READ "${launch_log}" launch_output)
  string(TIMESTAMP launch_finished "%Y-%m-%dT%H:%M:%SZ" UTC)
  file(APPEND "${log_path}" "Launch returned: ${launch_finished}\n")
  file(APPEND "${log_path}" "Launch (${launch_result}): ${launch_output}\nToken: ${token}\n")

  set(report "")
  set(completed FALSE)
  # A timed-out simctl request may still launch the app inside the simulator.
  # Allow its acknowledgement window before cleanup, without relaunching it.
  set(await_result FALSE)
  if(launch_result STREQUAL "0" OR launch_result MATCHES "[Tt]imeout")
    set(await_result TRUE)
  endif()
  if(await_result)
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
  if(NOT await_result OR NOT completed
      OR NOT report STREQUAL "${token} STAR_IOS_SMOKE_PASSED")
    # Include diagnostics in the existing artifact and in the Actions console.
    execute_process(COMMAND xcrun simctl spawn "${udid}" log show
      --last 2m --style compact
      --predicate "process == 'ios_consumer' OR process == 'v8_consumer' OR eventMessage CONTAINS 'org.star-engine.binaries.smoke'"
      TIMEOUT 20 RESULT_VARIABLE diagnostic_result
      OUTPUT_VARIABLE diagnostic_output ERROR_VARIABLE diagnostic_error)
    file(APPEND "${log_path}"
      "System log (${diagnostic_result}):\n${diagnostic_output}\n${diagnostic_error}\n")
    message(STATUS "Launch (${launch_result}): ${launch_output}\nResult: ${report}")
    message(FATAL_ERROR "Simulator smoke test failed or timed out. "
      "simctl result: ${launch_result}; completed: ${completed}; see ${log_path}")
  endif()
  if(NOT launch_result STREQUAL "0")
    message(STATUS "simctl launch timed out, but this launch's smoke test acknowledged success")
  endif()
  message(STATUS "${report}")
endfunction()
