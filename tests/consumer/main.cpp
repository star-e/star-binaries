#include <zlib.h>

#include <array>
#include <iostream>
#include <string_view>
#include <vector>

int main() {
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