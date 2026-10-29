"""Orchestration/format fixtures, not evidence of a working mobile runtime."""

import hashlib
import importlib.util
import json
from pathlib import Path
import re
import struct
import subprocess
import tempfile
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("mobile_pack", ROOT / "scripts/dotnet/validate-mobile-pack.py")
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)
TARGETS = {
    "arm64-android-star": "android-arm64", "x64-android-star": "android-x64",
    "arm64-ios-star": "ios-arm64", "arm64-ios-simulator-star": "iossimulator-arm64",
}


def native_image(rid):
    if rid.startswith("android-"):
        data = bytearray(64)
        data[:6] = b"\x7fELF\x02\x01"
        struct.pack_into("<HH", data, 16, 3, 183 if rid.endswith("-arm64") else 62)
        return bytes(data)
    platform = 7 if rid.startswith("iossimulator-") else 2
    return (struct.pack("<8I", 0xFEEDFACF, 0x100000C, 0, 6, 1, 24, 0, 0)
            + struct.pack("<6I", 0x32, 24, platform, 0, 0, 0))


def fixture(rid, version="test"):
    prefix = f"runtimes/{rid}/"
    entries = {
        "runtime.nuspec": f'<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">'
                          f'<metadata><id>Microsoft.NETCore.App.Runtime.{rid}</id>'
                          f'<version>{version}</version></metadata></package>',
        prefix + "lib/net11.0/System.Private.CoreLib.dll": b"MZfixture",
        "data/RuntimeList.xml": "<FileList />",
    }
    libraries = (["libcoreclr.so", "libclrjit.so"] if rid.startswith("android-")
                 else ["libcoreclr.dylib", "Microsoft.NETCore.App.Runtime.CoreCLR.r2r.dylib"])
    for name in libraries:
        entries[prefix + "native/" + name] = native_image(rid)
    return entries


def write_pack(path, entries):
    with zipfile.ZipFile(path, "w") as pack:
        for name, data in entries.items():
            pack.writestr(name, data)


class MobileBuildTests(unittest.TestCase):
    def setUp(self):
        (ROOT / "out/dotnet").mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="mobile-test-", dir=ROOT / "out/dotnet")
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)

    def cmake(self, *args):
        return subprocess.run(["cmake", *args], cwd=ROOT, text=True, capture_output=True)

    def test_build_plans(self):
        for triplet, rid in TARGETS.items():
            with self.subTest(triplet=triplet):
                result = self.cmake(f"-DTRIPLET={triplet}", "-DPRINT_ARGS=ON", "-DJOBS=2",
                                    "-P", "scripts/build-dotnet.cmake")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"Microsoft.NETCore.App.Runtime.{rid}.", result.stdout)
                self.assertIn("/p:RuntimeFlavor=CoreCLR", result.stdout)
                self.assertIn("/maxcpucount:2", result.stdout)
                self.assertEqual("FeatureDynamicCodeCompiled=false" in result.stdout, rid.startswith("ios"))
                self.assertNotIn("Compiler:", result.stdout)

    def test_invalid_options(self):
        for option in ("-DJOBS=0", "-DCONFIGURATION=Debug"):
            result = self.cmake("-DTRIPLET=arm64-android-star", "-DPRINT_ARGS=ON", option,
                                "-P", "scripts/build-dotnet.cmake")
            self.assertNotEqual(result.returncode, 0)
        result = self.cmake("-DTRIPLET=x64-ios-star", "-DPRINT_ARGS=ON", "-P", "scripts/build-dotnet.cmake")
        self.assertNotEqual(result.returncode, 0)

    def test_all_pack_targets(self):
        for rid in TARGETS.values():
            with self.subTest(rid=rid):
                path = self.work / "test.nupkg"
                write_pack(path, fixture(rid))
                self.assertGreater(validator.validate_pack(path, rid, "test"), 0)

    def test_wrong_identity(self):
        path = self.work / "test.nupkg"
        write_pack(path, fixture("android-arm64"))
        for rid, version in (("android-x64", "test"), ("android-arm64", "other")):
            with self.assertRaisesRegex(ValueError, "Wrong runtime pack"):
                validator.validate_pack(path, rid, version)

    def test_wrong_native_target(self):
        for rid, other in (("android-arm64", "android-x64"), ("ios-arm64", "iossimulator-arm64")):
            entries = fixture(rid)
            name = next(name for name in entries if "/native/libcoreclr" in name)
            entries[name] = native_image(other)
            path = self.work / "test.nupkg"
            write_pack(path, entries)
            with self.assertRaisesRegex(ValueError, "Wrong (ELF architecture|Apple platform)"):
                validator.validate_pack(path, rid, "test")

    def test_missing_execution_image(self):
        for rid, suffix in (("android-arm64", "libclrjit.so"), ("ios-arm64", ".r2r.dylib")):
            entries = {name: data for name, data in fixture(rid).items() if not name.endswith(suffix)}
            path = self.work / "test.nupkg"
            write_pack(path, entries)
            with self.assertRaisesRegex(ValueError, "Missing (Android JIT|Apple composite)"):
                validator.validate_pack(path, rid, "test")

    def test_truncated_native_and_unsafe_path(self):
        with self.assertRaisesRegex(ValueError, "Truncated Mach-O"):
            validator.validate_native(native_image("ios-arm64")[:-1], "ios-arm64", "test")
        path = self.work / "test.nupkg"
        entries = fixture("android-arm64")
        entries["../escaped"] = b"bad"
        write_pack(path, entries)
        with self.assertRaisesRegex(ValueError, "Invalid pack path"):
            validator.validate_pack(path, "android-arm64", "test")

    def test_packaging_relocation_and_failure(self):
        pin = (ROOT / "dotnet-version.cmake").read_text()
        upstream = re.search(r'set\(STAR_DOTNET_VERSION "([^"]+)"', pin)[1]
        suffix = re.search(r'set\(STAR_DOTNET_VERSION_SUFFIX "([^"]+)"', pin)[1]
        version = "11.0.0-" + suffix
        source = self.work / "source"
        shipping = source / "artifacts/packages/Release/Shipping"
        shipping.mkdir(parents=True)
        pack = shipping / f"Microsoft.NETCore.App.Runtime.iossimulator-arm64.{version}.nupkg"
        entries = fixture("iossimulator-arm64", version)
        write_pack(pack, entries)
        for name in ("LICENSE.TXT", "THIRD-PARTY-NOTICES.TXT", "global.json",
                     "src/coreclr/hosts/inc/coreclrhost.h", "src/native/corehost/coreclr_delegates.h"):
            path = source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("fixture")
        driver = self.work / "package.cmake"
        driver.write_text(f'''cmake_minimum_required(VERSION 3.26)
set(root "{ROOT.as_posix()}")
include("${{root}}/dotnet-version.cmake")
include("${{root}}/scripts/dotnet/common.cmake")
set(TRIPLET arm64-ios-simulator-star)
set(JOBS 2)
include("${{root}}/scripts/dotnet/mobile-platform.cmake")
set(source "{source.as_posix()}")
set(output "{self.work.as_posix()}/output")
set(revision "${{STAR_DOTNET_REVISION}}")
include("${{root}}/scripts/dotnet/package-mobile.cmake")
''')
        import sys
        result = self.cmake(f"-DPython3_EXECUTABLE={sys.executable}", "-P", str(driver))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        archive = self.work / "output" / f"star-dotnet-{upstream}-arm64-ios-simulator-star-release-runtime-pack.tar.gz"
        archive_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
        self.assertTrue(Path(str(archive) + ".sha256").read_text().startswith(archive_hash))
        receipt = next((self.work / "output").glob("staging-*/relocated runtime pack/*/provenance/build.json"))
        self.assertFalse(json.loads(receipt.read_text())["runtimeTested"])
        # Failed content checks must not replace an existing successful archive.
        entries["runtime.nuspec"] = entries["runtime.nuspec"].replace(version, "wrong-version")
        write_pack(pack, entries)
        result = self.cmake(f"-DPython3_EXECUTABLE={sys.executable}", "-P", str(driver))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(), archive_hash)


if __name__ == "__main__":
    unittest.main(verbosity=2)
