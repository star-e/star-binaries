#include <gsl/assert>
#include <gsl/pointers>
#include <gsl/span>

namespace {
int sumValues(gsl::span<const int> values) {
    Expects(!values.empty());
    int sum = 0;
    for (int value : values) sum += value;
    Ensures(sum > 0);
    return sum;
}
}

bool star_gsl_smoke() {
    int values[]{2, 3, 5};
    gsl::not_null<int*> first{values};
    *first = 7;
    return sumValues(values) == 15 && values[0] == 7;
}
