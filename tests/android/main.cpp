#include <iostream>

int star_zlib_roundtrip();

int main() {
    const int result = star_zlib_roundtrip();
    std::cout << (result == 0 ? "STAR_ANDROID_SMOKE_PASSED\n"
                             : "STAR_ANDROID_SMOKE_FAILED\n");
    return result;
}
