#!/usr/bin/env python3
"""Build the versioned runtime bundles published on GitHub Releases."""

import argparse
import gzip
import hashlib
import io
import re
import stat
import subprocess
import tarfile
import zipfile
from pathlib import Path, PurePosixPath


REPO = Path(__file__).resolve().parents[1]
CACHE_DIRS = {"__pycache__", ".cache", ".pytest_cache", ".mypy_cache", ".ruff_cache",
              "node_modules", ".git", ".github"}
# Retired paths that installed remote.sh/remote.ps1 still require before they
# accept a bundle. Ship them as inert files; no installer channel lists them.
RETIRED_REQUIRED_FILES = {
    "skill/job-profile-root/SKILL.md": (
        "---\n"
        "name: job-profile-root\n"
        "description: \"Retired. Use job-profile to resolve the Profile root.\"\n"
        "---\n\n"
        "Retired. Profile-root resolution moved to `job-profile`. Reinstall with the\n"
        "current installer to remove this link.\n"
    ).encode("utf-8"),
}


def build_release(version: str, output: Path) -> None:
    """Package tracked runtime files, using the tag as the version source."""
    if re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", version) is None:
        raise ValueError("version must be a stable tag in the form vX.Y.Z")

    tracked = subprocess.run(
        ["git", "ls-files", "--stage", "-z"],
        cwd=REPO,
        check=True,
        capture_output=True,
        text=True,
    )
    files = []
    for record in tracked.stdout.split("\0"):
        if not record:
            continue
        metadata, name = record.split("\t", 1)
        mode, _, stage = metadata.split()
        path = PurePosixPath(name)
        is_skill = path.parts[0] == "skill"
        is_script = (
            path.parts[0] == "scripts"
            and path.suffix in {".sh", ".ps1"}
            and name != "scripts/test.sh"
        )
        if not (name == "LICENSE" or is_skill or is_script):
            continue
        if is_skill and (
            CACHE_DIRS.intersection(path.parts)
            or path.suffix in {".pyc", ".pyo"}
            or (path.name.startswith("test_") and path.suffix == ".py")
        ):
            continue
        if stage != "0" or mode not in {"100644", "100755"}:
            raise ValueError("runtime file must be a regular, unconflicted file: " + name)
        source = REPO / name
        if source.is_symlink():
            raise ValueError("runtime file must not be a symlink: " + name)
        files.append(("job-kit/" + name, source.read_bytes(), int(mode, 8) & 0o777))

    shipped = {name for name, _, _ in files}
    for name, data in sorted(RETIRED_REQUIRED_FILES.items()):
        if "job-kit/" + name not in shipped:
            files.append(("job-kit/" + name, data, 0o644))

    version_bytes = (version + "\n").encode("utf-8")
    files.append(("job-kit/VERSION", version_bytes, 0o644))
    files.sort()
    directories = {"job-kit"}
    for name, _, _ in files:
        directories.update(
            str(parent)
            for parent in PurePosixPath(name).parents
            if str(parent) != "."
        )

    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    tar_path = output / ("job-kit-" + version + ".tar.gz")
    zip_path = output / ("job-kit-" + version + ".zip")
    with tar_path.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w") as archive:
                for name in sorted(directories):
                    entry = tarfile.TarInfo(name + "/")
                    entry.type = tarfile.DIRTYPE
                    entry.mode = 0o755
                    archive.addfile(entry)
                for name, data, mode in files:
                    entry = tarfile.TarInfo(name)
                    entry.mode = mode
                    entry.size = len(data)
                    archive.addfile(entry, io.BytesIO(data))

    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(directories):
            entry = zipfile.ZipInfo(name + "/")
            entry.create_system = 3
            entry.external_attr = ((stat.S_IFDIR | 0o755) << 16) | 0x10
            archive.writestr(entry, b"")
        for name, data, mode in files:
            entry = zipfile.ZipInfo(name)
            entry.create_system = 3
            entry.external_attr = (stat.S_IFREG | mode) << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, data)

    (output / "VERSION").write_bytes(version_bytes)
    checksums = "".join(
        hashlib.sha256(path.read_bytes()).hexdigest() + "  " + path.name + "\n"
        for path in (tar_path, zip_path)
    )
    (output / "SHA256SUMS").write_bytes(checksums.encode("ascii"))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--version", required=True, help="stable release tag, such as v1.0.0"
    )
    parser.add_argument(
        "--output", required=True, type=Path,
        help="output directory for the four release assets",
    )
    args = parser.parse_args()
    try:
        build_release(args.version, args.output)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, "package_release.py: " + str(error) + "\n")


if __name__ == "__main__":
    main()
