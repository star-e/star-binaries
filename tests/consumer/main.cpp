#include <iostream>

bool star_boost_smoke();
bool star_stdexec_smoke();
bool star_gsl_smoke();

int main() {
    if (!star_gsl_smoke()) {
        std::cerr << "Microsoft GSL smoke test failed\n";
        return 1;
    }
    std::cout << "Microsoft GSL contracts/span/not_null smoke test passed\n";
    if (!star_stdexec_smoke()) {
        std::cerr << "stdexec smoke test failed\n";
        return 1;
    }
    std::cout << "stdexec sender/coroutine smoke test passed\n";
    if (!star_boost_smoke()) {
        std::cerr << "Boost container smoke test failed\n";
        return 1;
    }
    std::cout << "Boost container smoke test passed\n";
    return 0;
}
