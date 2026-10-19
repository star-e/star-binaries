#include <iostream>

int star_smoke_main();

int main() {
    const int result = star_smoke_main();
    std::cout << (result == 0 ? "STAR_ANDROID_SMOKE_PASSED\n"
                             : "STAR_ANDROID_SMOKE_FAILED\n");
    return result;
}
