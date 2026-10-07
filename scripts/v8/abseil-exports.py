"""Generate Windows Abseil exports for the selected compiler/STL and config.

Chromium's checked-in .def files contain libc++ (__Cr) symbol names. Inspect
the actual objects instead when building with the MSVC standard library.
"""

from pathlib import Path
import os
import re
import shutil
import subprocess
import sys


def main():
    object_root, environment_file, output = map(Path, sys.argv[1:])
    environment = os.environ.copy()
    environment.update(
        entry.split("=", 1)
        for entry in environment_file.read_text().rstrip("\0").split("\0")
    )
    tool = shutil.which("dumpbin.exe", path=environment["PATH"])
    if not tool:
        raise RuntimeError("dumpbin.exe is missing from the GN toolchain environment")
    objects = sorted(object_root.rglob("*.obj"))
    if not objects:
        raise RuntimeError(f"No Abseil objects found in {object_root}")
    symbols = {}
    explicit_exports = set()
    for obj in objects:
        report = subprocess.check_output(
            [tool, "/nologo", "/symbols", "/directives", str(obj)],
            env=environment,
        ).decode("utf-8", errors="replace")
        explicit_exports.update(re.findall(r'/EXPORT:"?([^\s",]+)', report, re.I))
        for line in report.splitlines():
            match = re.search(r"\bSECT[0-9A-F]+\b.*?\bExternal\s+\|\s+(\S+)", line)
            if not match:
                continue
            symbol = match[1]
            if not ((symbol.startswith("?") and "absl" in symbol) or symbol.startswith("Absl")):
                continue
            if symbol.startswith(("??_G", "??_E")):
                continue  # Deleting destructors cannot be DLL exports.
            symbols[symbol] = "" if "()" in line.split("|", 1)[0] else " DATA"
    entries = sorted(set(symbols) - explicit_exports)
    if not entries:
        raise RuntimeError("No Abseil exports found")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        "EXPORTS\n" + "".join(f"    {name}{symbols[name]}\n" for name in entries),
        encoding="utf-8",
    )
    print(f"Generated {len(entries)} Abseil exports from {len(objects)} objects")


if __name__ == "__main__":
    main()
