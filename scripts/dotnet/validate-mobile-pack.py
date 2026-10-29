"""Check a built CoreCLR runtime pack; this does not execute the runtime."""

import argparse
from pathlib import PurePosixPath
import struct
import xml.etree.ElementTree as ET
import zipfile


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_native(data, rid, name):
    if rid.startswith("android-"):
        require(len(data) >= 64 and data[:6] == b"\x7fELF\x02\x01", f"Expected ELF64: {name}")
        machine = struct.unpack_from("<H", data, 18)[0]
        expected = 183 if rid.endswith("-arm64") else 62
        require(machine == expected, f"Wrong ELF architecture for {rid}: {name}")
        require(struct.unpack_from("<H", data, 16)[0] == 3, f"Expected shared library: {name}")
    else:
        require(len(data) >= 32 and data[:4] == b"\xcf\xfa\xed\xfe", f"Expected Mach-O64: {name}")
        require(struct.unpack_from("<I", data, 4)[0] == 0x100000C, f"Expected arm64: {name}")
        require(struct.unpack_from("<I", data, 12)[0] == 6, f"Expected Mach-O dylib: {name}")
        count, command_bytes = struct.unpack_from("<II", data, 16)
        end = 32 + command_bytes
        require(end <= len(data), f"Truncated Mach-O commands: {name}")
        position = 32
        platforms = []
        for _ in range(count):
            require(position + 8 <= end, f"Truncated Mach-O command: {name}")
            command, size = struct.unpack_from("<II", data, position)
            require(size >= 8 and position + size <= end, f"Invalid Mach-O command size: {name}")
            if command == 0x32:  # LC_BUILD_VERSION
                require(size >= 24, f"Truncated LC_BUILD_VERSION: {name}")
                platforms.append(struct.unpack_from("<I", data, position + 8)[0])
            position += size
        expected = 7 if rid.startswith("iossimulator-") else 2
        require(platforms == [expected], f"Wrong Apple platform for {rid}: {name} ({platforms})")


def validate_pack(path, rid, version):
    require(rid in ("android-arm64", "android-x64", "ios-arm64", "iossimulator-arm64"),
            f"Unsupported mobile RID: {rid}")
    with zipfile.ZipFile(path) as pack:
        names = pack.namelist()
        require(len(names) == len(set(names)), "Duplicate entries in runtime pack")
        for name in names:
            parts = PurePosixPath(name).parts
            require(not name.startswith("/") and ".." not in parts and "\\" not in name
                    and ":" not in name, f"Invalid pack path: {name}")
        require(pack.testzip() is None, "Runtime pack CRC check failed")
        specs = [name for name in names if name.endswith(".nuspec") and "/" not in name]
        require(len(specs) == 1, "Expected one NuGet specification")
        metadata = ET.fromstring(pack.read(specs[0])).find("{*}metadata")
        require(metadata is not None, "Missing NuGet metadata")
        require(metadata.findtext("{*}id") == f"Microsoft.NETCore.App.Runtime.{rid}", "Wrong runtime pack ID")
        require(metadata.findtext("{*}version") == version, "Wrong runtime pack version")
        prefix = f"runtimes/{rid}/"
        require(all(not name.startswith("runtimes/") or name.startswith(prefix) for name in names),
                "Runtime pack contains another RID")
        corelib = prefix + "lib/net11.0/System.Private.CoreLib.dll"
        require(corelib in names and pack.read(corelib)[:2] == b"MZ", "Missing or invalid CoreLib")
        require("data/RuntimeList.xml" in names, "Missing runtime pack manifest")
        suffix = ".so" if rid.startswith("android-") else ".dylib"
        native = [name for name in names if name.startswith(prefix + "native/") and name.endswith(suffix)]
        require(prefix + "native/libcoreclr" + suffix in native, "Missing CoreCLR library")
        if rid.startswith("android-"):
            require(prefix + "native/libclrjit.so" in native, "Missing Android JIT")
        else:
            require(any(name.endswith(".r2r.dylib") for name in native), "Missing Apple composite ReadyToRun image")
        for name in native:
            validate_native(pack.read(name), rid, name)
    return len(names)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pack")
    parser.add_argument("--rid", required=True)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    entries = validate_pack(args.pack, args.rid, args.version)
    print(f"CoreCLR pack content checks passed: {args.rid}, {entries} entries (runtime execution pending)")
