#include <exec/single_thread_context.hpp>
#include <exec/task.hpp>
#include <stdexec/execution.hpp>

#include <stdexcept>
#include <string_view>
#include <thread>
#include <tuple>

namespace {

exec::task<int> answer() {
    const int value = co_await stdexec::just(21);
    co_return value * 2;
}

exec::task<void> fail() {
    throw std::runtime_error("stdexec smoke error");
    co_return;
}

exec::task<void> stop(bool& resumed) {
    co_await stdexec::just_stopped();
    resumed = true;
}

} // namespace

bool star_stdexec_smoke() {
    auto value = stdexec::sync_wait(answer() | stdexec::then([](int v) { return v + 1; }));
    if (!value || std::get<0>(*value) != 43) {
        return false;
    }

    // Exercise a real queue and thread, not only inline completion.
    exec::single_thread_context context;
    auto thread = stdexec::sync_wait(stdexec::schedule(context.get_scheduler()) |
                                    stdexec::then([] { return std::this_thread::get_id(); }));
    if (!thread || std::get<0>(*thread) != context.get_thread_id()) {
        return false;
    }

    bool resumed = false;
    if (stdexec::sync_wait(stop(resumed)) || resumed) {
        return false;
    }
    try {
        stdexec::sync_wait(fail());
        return false;
    } catch (const std::runtime_error& error) {
        return std::string_view(error.what()) == "stdexec smoke error";
    }
}
