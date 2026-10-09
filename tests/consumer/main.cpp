#include <zlib.h>

#include <array>
#include <iostream>
#include <string_view>
#include <vector>

bool star_boost_smoke();
bool star_stdexec_smoke();

int main() {
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
    constexpr std::string_view message = "star-binaries zlib round-trip";
    auto compressed_size = compressBound(static_cast<uLong>(message.size()));
    std::vector<Bytef> compressed(compressed_size);
    if (compress(compressed.data(), &compressed_size,
                 reinterpret_cast<const Bytef*>(message.data()),
                 static_cast<uLong>(message.size())) != Z_OK) {
        std::cerr << "Compression failed\n";
        return 1;
    }

    std::array<char, message.size()> restored{};
    auto restored_size = static_cast<uLongf>(restored.size());
    if (uncompress(reinterpret_cast<Bytef*>(restored.data()), &restored_size,
                   compressed.data(), compressed_size) != Z_OK ||
        std::string_view(restored.data(), restored_size) != message) {
        std::cerr << "Round-trip failed\n";
        return 1;
    }
    std::cout << "zlib " << zlibVersion() << ": round-trip passed\n";
    return 0;
}
