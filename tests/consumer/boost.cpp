#include <boost/container/pmr/monotonic_buffer_resource.hpp>
#include <boost/container/pmr/vector.hpp>
#include <boost/container/small_vector.hpp>
#include <boost/dynamic_bitset.hpp>
#include <boost/unordered/concurrent_flat_map.hpp>
#include <boost/unordered/unordered_flat_map.hpp>

#include <thread>

bool star_boost_smoke() {
    // PMR exercises compiled Boost.Container symbols, not just its headers.
    boost::container::pmr::monotonic_buffer_resource resource;
    boost::container::pmr::vector<int> values(&resource);
    values.push_back(7);
    boost::container::small_vector<int, 2> small{1, 2, 3};
    boost::unordered_flat_map<int, int> map{{1, 7}};
    boost::dynamic_bitset<> bits(65);
    bits.set(64);
    boost::concurrent_flat_map<int, int> concurrent;
    auto insert = [&](int start) {
        for (int i = start; i < start + 100; ++i) concurrent.emplace(i, i);
    };
    std::thread a(insert, 0), b(insert, 100);
    a.join();
    b.join();
    return values.front() == 7 && small.back() == 3 && map.at(1) == 7 &&
        bits.test(64) && bits.count() == 1 && concurrent.size() == 200;
}
