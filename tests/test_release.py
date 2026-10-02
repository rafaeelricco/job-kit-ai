"""Exercise shipped archives and native installers with local download fixtures.

Installer destinations use the existing JOB_KIT_HOME, CLAUDE_SKILLS and
ASIDE_SKILLS overrides. The tests never install into the operator's agent homes.
Network commands are intercepted in child shells; unexpected URLs fail closed.
"""

import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from functools import lru_cache
from pathlib import Path
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO / "tests"))
import package_release  # noqa: E402
from test_packaging import INSTALLERS, required_files  # noqa: E402


def _marker_skill_tail(path):
    """Compare .job-kit markers across Win32 and Git Bash spellings of the same path."""
    text = path.replace("\\", "/").lower().replace("/c/", "c:/")
    index = text.find("/skill/")
    return text[index:] if index >= 0 else text


@lru_cache(maxsize=2)
def release_assets(version):
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory)
        package_release.build_release(version, output)
        return {path.name: path.read_bytes() for path in output.iterdir()}


def tar_files(data):
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        return {
            entry.name: archive.extractfile(entry).read()
            for entry in archive.getmembers()
            if entry.isfile()
        }


def write_payload(directory, version, changes=None):
    """Rewrite fixture archives and checksums, including intentionally bad trees."""
    assets = dict(release_assets(version))
    if changes:
        files = tar_files(assets["job-kit-%s.tar.gz" % version])
        for path, content in changes.items():
            name = "job-kit/" + path
            if content is None:
                files.pop(name, None)
            else:
                files[name] = content
        tar_buffer, zip_buffer = io.BytesIO(), io.BytesIO()
        with tarfile.open(fileobj=tar_buffer, mode="w:gz") as archive:
            for name, content in sorted(files.items()):
                entry = tarfile.TarInfo(name)
                entry.size = len(content)
                entry.mode = 0o755 if name.endswith(".sh") else 0o644
                archive.addfile(entry, io.BytesIO(content))
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, content in sorted(files.items()):
                archive.writestr(name, content)
        assets["job-kit-%s.tar.gz" % version] = tar_buffer.getvalue()
        assets["job-kit-%s.zip" % version] = zip_buffer.getvalue()
        assets["SHA256SUMS"] = "".join(
            "%s  %s\n" % (hashlib.sha256(assets[name]).hexdigest(), name)
            for name in sorted(assets)
            if name.endswith((".tar.gz", ".zip"))
        ).encode()
    directory.mkdir(parents=True, exist_ok=True)
    for name, content in assets.items():
        (directory / name).write_bytes(content)


def native_shells():
    if os.name != "nt":
        return [("bash", "/bin/bash")]
    result = []
    for base in (os.environ.get("ProgramFiles", "C:/Program Files"),
                 os.environ.get("ProgramFiles(x86)", "C:/Program Files (x86)")):
        bash = Path(base) / "Git/bin/bash.exe"
        if bash.is_file():
            result.append(("bash", str(bash)))
            break
    for name in ("powershell", "pwsh"):
        executable = shutil.which(name)
        if executable:
            result.append((name, executable))
    return result


def shell_path(path, kind):
    text = str(path)
    if kind == "bash" and os.name == "nt":
        text = text.replace("\\", "/")
        if len(text) > 1 and text[1] == ":":
            text = "/" + text[0].lower() + text[2:]
    return text


BASH_FIXTURES = r'''
fixture_download() {
  local url="$1" output="${2:-}" rel source
  printf '%s\n' "$url" >> "$RELEASE_TEST_TRACE"
  case "$url" in
    https://github.com/fixture/job-kit/releases/*)
      rel="${url#https://github.com/fixture/job-kit/releases/}" ;;
    *) echo "unexpected download: $url" >&2; return 97 ;;
  esac
  source="$RELEASE_TEST_FIXTURES/$rel"
  [ -f "$source" ] || { echo "fixture asset missing: $url" >&2; return 22; }
  if [ -n "$output" ] && [ "$output" != - ]; then
    builtin command cp "$source" "$output"
  else
    builtin command cat "$source"
  fi
}
curl() {
  local output="" url=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -o|--output) output="$2"; shift ;;
      https://*) url="$1" ;;
    esac
    shift
  done
  fixture_download "$url" "$output"
}
wget() {
  local output="" url=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -O) output="$2"; shift ;;
      -qO-) output=- ;;
      https://*) url="$1" ;;
    esac
    shift
  done
  fixture_download "$url" "$output"
}
git() { echo 'unexpected git invocation' >> "$RELEASE_TEST_TRACE"; return 99; }
command() {
  if [ "${1:-}" = -v ]; then
    [ "${2:-}" != git ] || return 1
    if [ "${RELEASE_TEST_WGET:-}" = 1 ] && [ "${2:-}" = curl ]; then return 1; fi
  fi
  builtin command "$@"
}
mv() {
  local source="" dest="" arg
  for arg in "$@"; do
    case "$arg" in -*) continue ;; esac
    [ -n "$source" ] || source="$arg"
    dest="$arg"
  done
  if [ "${RELEASE_TEST_FAIL_REPLACE:-}" = 1 ] &&
     [ "$dest" = "$RELEASE_TEST_PHYSICAL" ] && [ -f "$source/VERSION" ] &&
     [ ! -f "$RELEASE_TEST_FAILURE" ]; then
    : > "$RELEASE_TEST_FAILURE"
    echo 'injected replacement failure' >&2
    return 1
  fi
  builtin command mv "$@"
}
'''

POWERSHELL_FIXTURES = r'''
function Invoke-WebRequest {
  [CmdletBinding()]
  param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
  [IO.File]::AppendAllText($env:RELEASE_TEST_TRACE, $Uri + "`n")
  $prefix = 'https://github.com/fixture/job-kit/releases/'
  if (-not $Uri.StartsWith($prefix)) { throw "unexpected download: $Uri" }
  $source = Join-Path $env:RELEASE_TEST_FIXTURES $Uri.Substring($prefix.Length)
  if (-not [IO.File]::Exists($source)) { throw "fixture asset missing: $Uri" }
  if ($OutFile) {
    [IO.File]::Copy($source, $OutFile, $true)
  } else {
    [pscustomobject]@{ Content = [IO.File]::ReadAllText($source) }
  }
}
function git { throw 'unexpected git invocation' }
function Move-Item {
  [CmdletBinding()]
  param([string]$LiteralPath, [string]$Destination, [switch]$Force)
  if ($env:RELEASE_TEST_FAIL_REPLACE -eq '1' -and
      [IO.Path]::GetFullPath($Destination) -eq $env:RELEASE_TEST_PHYSICAL -and
      [IO.File]::Exists((Join-Path $LiteralPath 'VERSION')) -and
      -not [IO.File]::Exists($env:RELEASE_TEST_FAILURE)) {
    [IO.File]::WriteAllText($env:RELEASE_TEST_FAILURE, 'failed')
    throw 'injected replacement failure'
  }
  Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force
}
$global:LASTEXITCODE = 0
& $env:RELEASE_TEST_INSTALLER @args
exit $LASTEXITCODE
'''


class InstallFixture:
    def __init__(self, root, shell):
        self.root = root
        self.kind, self.executable = shell
        self.package = root / "installed kit"
        self.physical = self.package
        self.agents = root / "agent skills"
        self.aside = root / "aside skills"
        self.fixtures = root / "releases"
        self.trace = root / "downloads.log"
        self.profile = root / "config/job-kit/data/private.yaml"
        self.profile.parent.mkdir(parents=True)
        self.profile.write_text("private: unchanged\n", encoding="utf-8")
        self.agents.mkdir()
        self.aside.mkdir()
        for version in ("v1.0.0", "v1.0.1"):
            write_payload(self.fixtures / "download" / version, version)
        pointer = self.fixtures / "latest/download/VERSION"
        pointer.parent.mkdir(parents=True)
        pointer.write_bytes(b"v1.0.1\n")
        self.wrapper = root / ("fixtures.sh" if self.kind == "bash" else "fixtures.ps1")
        with self.wrapper.open("w", encoding="utf-8", newline="\n") as stream:
            stream.write(BASH_FIXTURES if self.kind == "bash" else POWERSHELL_FIXTURES)

    def run(self, *args, version="v1.0.0", extra=None, cached=False):
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("JOB_KIT_", "RELEASE_TEST_"))
               and k not in ("BASH_ENV", "ENV", "CLAUDE_SKILLS", "ASIDE_SKILLS", "ASIDE_ACCOUNT")}
        paths = {
            "JOB_KIT_HOME": self.package, "CLAUDE_SKILLS": self.agents,
            "ASIDE_SKILLS": self.aside, "XDG_CONFIG_HOME": self.root / "config",
            "RELEASE_TEST_TRACE": self.trace, "RELEASE_TEST_FIXTURES": self.fixtures,
            "RELEASE_TEST_PHYSICAL": self.physical,
            "RELEASE_TEST_FAILURE": self.root / "replacement-failed",
        }
        env.update({key: shell_path(path, self.kind) for key, path in paths.items()})
        env.update(JOB_KIT_SLUG="fixture/job-kit", JOB_KIT_VERSION=version,
                   PYTHONDONTWRITEBYTECODE="1")
        if extra:
            env.update(extra)
        source = self.package if cached else REPO
        installer = source / "scripts" / ("remote.sh" if self.kind == "bash" else "remote.ps1")
        if self.kind == "bash":
            env["BASH_ENV"] = shell_path(self.wrapper, self.kind)
            if os.name == "nt":
                env["MSYS"] = "winsymlinks:nativestrict"
            command = [self.executable, shell_path(installer, self.kind), *args]
        else:
            # Let each PowerShell edition build its own module search path.
            # CI launches Python from pwsh; inheriting that path breaks 5.1.
            env = {key: value for key, value in env.items()
                   if key.upper() != "PSMODULEPATH"}
            env["RELEASE_TEST_INSTALLER"] = str(installer)
            command = [self.executable, "-NoLogo", "-NoProfile", "-NonInteractive",
                       "-ExecutionPolicy", "Bypass", "-File", str(self.wrapper), *args]
        return subprocess.run(command, cwd=self.root, env=env, input="",
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=90)

    def backups(self):
        return sorted(self.physical.parent.glob(self.physical.name + ".backup-*"))

    def requests(self):
        return self.trace.read_text(encoding="utf-8").splitlines() if self.trace.exists() else []

    def make_alias(self):
        self.physical = self.root / "physical kit"
        self.package.rename(self.physical)
        if os.name == "nt":
            subprocess.run(["cmd", "/c", "mklink", "/J", str(self.package), str(self.physical)],
                           check=True, capture_output=True)
        else:
            self.package.symlink_to(self.physical, target_is_directory=True)


class ReleaseArchiveTests(unittest.TestCase):
    def test_archives_match_runtime_contract(self):
        assets = release_assets("v1.0.0")
        self.assertEqual(set(assets), {"job-kit-v1.0.0.tar.gz", "job-kit-v1.0.0.zip",
                                       "VERSION", "SHA256SUMS"})
        files = tar_files(assets["job-kit-v1.0.0.tar.gz"])
        with zipfile.ZipFile(io.BytesIO(assets["job-kit-v1.0.0.zip"])) as archive:
            self.assertEqual(files, {n: archive.read(n) for n in archive.namelist() if not n.endswith("/")})
        self.assertEqual(files["job-kit/VERSION"], b"v1.0.0\n")
        self.assertEqual(assets["VERSION"], b"v1.0.0\n")
        self.assertIn("job-kit/LICENSE", files)
        self.assertIn("job-kit/skill/captcha-solver/SKILL.md", files)
        for installer in INSTALLERS:
            for name in required_files(installer.path):
                self.assertIn("job-kit/" + name, files)
        for name in files:
            parts = Path(name).parts
            self.assertFalse(set(parts) & {".git", ".github", "node_modules", "__pycache__", "tests", "packages"}, name)
            self.assertFalse(Path(name).name.startswith("test_"), name)
            self.assertFalse(name.endswith((".pyc", ".pyo", "/scripts/test.sh", "/scripts/package_release.py")), name)
        for line in assets["SHA256SUMS"].decode().splitlines():
            digest, name = line.split()
            self.assertEqual(digest, hashlib.sha256(assets[name]).hexdigest())
        with tarfile.open(fileobj=io.BytesIO(assets["job-kit-v1.0.0.tar.gz"]), mode="r:gz") as archive:
            self.assertTrue(archive.getmember("job-kit/scripts/remote.sh").mode & 0o111)

    def test_packaging_rejects_nonrelease_versions(self):
        for version in ("main", "latest", "1.0.0", "v1.0", "v1.0.0-rc.1", "v1.0.0\n", "../v1.0.0"):
            with self.subTest(version=version), tempfile.TemporaryDirectory() as directory:
                with self.assertRaises((ValueError, SystemExit)):
                    package_release.build_release(version, Path(directory))
                self.assertEqual(list(Path(directory).iterdir()), [])

    def test_untracked_files_are_not_packaged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, output = root / "repo", root / "out"
            source.mkdir()
            subprocess.run(["git", "init", "-q", str(source)], check=True)
            for name, content in {"LICENSE": "license", "skill/example/SKILL.md": "skill",
                                  "skill/example/private.txt": "must not ship",
                                  "scripts/remote.sh": "#!/bin/bash\n"}.items():
                path = source / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8")
            subprocess.run(["git", "-C", str(source), "add", "LICENSE", "skill/example/SKILL.md",
                            "scripts/remote.sh"], check=True)
            with patch.object(package_release, "REPO", source):
                package_release.build_release("v1.0.0", output)
            files = tar_files((output / "job-kit-v1.0.0.tar.gz").read_bytes())
            self.assertNotIn("job-kit/skill/example/private.txt", files)
            self.assertIn("job-kit/skill/example/SKILL.md", files)

    def test_extracted_helpers_preserve_golden_behavior(self):
        files = tar_files(release_assets("v1.0.0")["job-kit-v1.0.0.tar.gz"])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, content in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
            unrelated = root / "unrelated"
            unrelated.mkdir()
            for fixture in sorted((REPO / "tests/golden").glob("*.json")):
                case = json.loads(fixture.read_text(encoding="utf-8"))
                with self.subTest(fixture=fixture.name):
                    result = subprocess.run([sys.executable, str(root / "job-kit" / case["script"]),
                                             *case.get("argv", [])], input=json.dumps(case["stdin"]),
                                            capture_output=True, text=True, cwd=unrelated, timeout=30)
                    self.assertEqual(result.returncode, case["exit"], result.stderr)
                    self.assertEqual(json.loads(result.stdout), case["stdout"])


class ReleaseInstallerTests(unittest.TestCase):
    def each_shell(self, scenario):
        shells = native_shells()
        self.assertTrue(shells, "no native installer shell found")
        for shell in shells:
            with self.subTest(shell=shell[0]), tempfile.TemporaryDirectory() as directory:
                fixture = InstallFixture(Path(directory).resolve(), shell)
                scenario(fixture)
                self.assertEqual(fixture.profile.read_text(encoding="utf-8"), "private: unchanged\n")
                self.assertNotIn("unexpected git invocation", "\n".join(fixture.requests()))

    def success(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_expected_native_shells_are_available_in_ci(self):
        if os.environ.get("GITHUB_ACTIONS") != "true":
            self.skipTest("native shell inventory is enforced on CI runners")
        expected = {"bash", "powershell", "pwsh"} if os.name == "nt" else {"bash"}
        self.assertEqual({kind for kind, _ in native_shells()}, expected)

    def test_install_repeat_upgrade_and_offline_uninstall(self):
        def scenario(f):
            result = f.run("agents")
            self.success(result)
            self.assertIn("v1.0.0", result.stdout + result.stderr)
            self.assertEqual((f.package / "VERSION").read_text(), "v1.0.0\n")
            self.assertFalse((f.package / ".git").exists())
            installed = f.agents / "job-match"
            self.assertEqual(installed.resolve(), (f.physical / "skill/job-match").resolve())
            self.assertEqual(len(list(f.agents.iterdir())), 10)
            self.success(f.run("agents"))
            self.success(f.run("agents", version="v1.0.1"))
            self.assertEqual((f.package / "VERSION").read_text(), "v1.0.1\n")
            self.assertEqual(installed.resolve(), (f.physical / "skill/job-match").resolve())
            self.assertEqual(f.backups(), [])
            requests = f.requests()
            self.success(f.run("uninstall", "agents", version="latest",
                               extra={"JOB_KIT_REF": "main"}, cached=True))
            self.assertEqual(f.requests(), requests)
            self.assertEqual(list(f.agents.iterdir()), [])
            self.assertTrue(f.package.is_dir())
        self.each_shell(scenario)

    def test_latest_resolves_once_and_pin_skips_pointer(self):
        def scenario(f):
            self.success(f.run("fetch", version="latest"))
            requests = f.requests()
            self.assertEqual(sum("/latest/" in url for url in requests), 1)
            self.assertTrue(all("/latest/" in url or "/download/v1.0.1/" in url for url in requests))
            self.assertEqual((f.package / "VERSION").read_text(), "v1.0.1\n")
            self.success(f.run("fetch", version="v1.0.0"))
            self.assertTrue(all("/download/v1.0.0/" in url for url in f.requests()[len(requests):]))
        self.each_shell(scenario)

    def test_dry_run_refreshes_package_without_installing_skills(self):
        def scenario(f):
            self.success(f.run("agents", "--dry-run"))
            self.assertTrue((f.package / "VERSION").is_file())
            self.assertEqual(list(f.agents.iterdir()), [])
        self.each_shell(scenario)

    def test_legacy_migration_retains_edits_and_git_metadata(self):
        def scenario(f):
            self.success(f.run("agents"))
            (f.package / "VERSION").unlink()
            (f.package / ".git").mkdir()
            (f.package / ".git/HEAD").write_text("ref: refs/heads/main\n")
            (f.package / "local-notes.txt").write_text("keep me")
            (f.package / "skill/job-match/SKILL.md").write_text("local edit")
            self.success(f.run("agents", version="v1.0.1"))
            backups = f.backups()
            self.assertEqual(len(backups), 1)
            self.assertEqual((backups[0] / "local-notes.txt").read_text(), "keep me")
            self.assertEqual((backups[0] / "skill/job-match/SKILL.md").read_text(), "local edit")
            self.assertTrue((backups[0] / ".git/HEAD").is_file())
            self.assertFalse((f.package / ".git").exists())
            self.success(f.run("uninstall", "agents"))
            self.assertTrue(backups[0].is_dir())
        self.each_shell(scenario)

    def test_source_archive_migration_preserves_cache_alias(self):
        def scenario(f):
            self.success(f.run("fetch"))
            (f.package / "VERSION").unlink()
            (f.package / "notes.txt").write_text("legacy archive")
            f.make_alias()
            self.success(f.run("fetch", version="v1.0.1"))
            self.assertEqual(f.package.resolve(), f.physical.resolve())
            self.assertEqual((f.physical / "VERSION").read_text(), "v1.0.1\n")
            self.assertEqual((f.backups()[0] / "notes.txt").read_text(), "legacy archive")
        self.each_shell(scenario)

    def test_invalid_inputs_leave_installed_package_unchanged(self):
        def scenario(f):
            self.success(f.run("fetch"))
            marker = f.package / "preserve.txt"
            marker.write_text("unchanged")
            cases = [("main", {}), ("../v1.0.1", {}), ("v1.0.1-rc.1", {}),
                     ("v1.0.0", {"JOB_KIT_REF": "main"}), ("v99.0.0", {})]
            for version, extra in cases:
                with self.subTest(version=version, extra=extra):
                    self.assertNotEqual(f.run("fetch", version=version, extra=extra).returncode, 0)
                    self.assertEqual(marker.read_text(), "unchanged")
                    self.assertEqual((f.package / "VERSION").read_text(), "v1.0.0\n")
            for pointer in ("not-a-version\n", "v1.0.1\n\n"):
                (f.fixtures / "latest/download/VERSION").write_text(pointer)
                self.assertNotEqual(f.run("fetch", version="latest").returncode, 0)
                self.assertEqual(marker.read_text(), "unchanged")
        self.each_shell(scenario)

    def test_corrupt_incomplete_and_wrong_version_assets_leave_cache_unchanged(self):
        def scenario(f):
            self.success(f.run("fetch"))
            asset_dir = f.fixtures / "download/v1.0.1"
            (asset_dir / "SHA256SUMS").write_text("0" * 64 + "  job-kit-v1.0.1.tar.gz\n" +
                                                  "0" * 64 + "  job-kit-v1.0.1.zip\n")
            self.assertNotEqual(f.run("fetch", version="v1.0.1").returncode, 0)
            for change in ({"skill/job-match/scripts/models.py": None},
                           {"skill/captcha-solver/SKILL.md": None},
                           {"VERSION": b"v9.9.9\n"}, {"scripts/remote.ps1": None},
                           {"VERSION": b"v1.0.1\n\n"}, {".git/HEAD": b"ref: refs/heads/main\n"},
                           {"../escaped.txt": b"must not extract"}):
                with self.subTest(change=list(change)):
                    write_payload(asset_dir, "v1.0.1", change)
                    self.assertNotEqual(f.run("fetch", version="v1.0.1").returncode, 0)
                    self.assertEqual((f.package / "VERSION").read_text(), "v1.0.0\n")
                    self.assertEqual(f.backups(), [])
        self.each_shell(scenario)

    def test_failed_replacement_restores_previous_package(self):
        def scenario(f):
            self.success(f.run("agents"))
            result = f.run("fetch", version="v1.0.1", extra={"RELEASE_TEST_FAIL_REPLACE": "1"})
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue((f.root / "replacement-failed").exists())
            self.assertEqual((f.package / "VERSION").read_text(), "v1.0.0\n")
            self.assertTrue((f.agents / "job-match/SKILL.md").is_file())
        self.each_shell(scenario)

    def test_foreign_cache_worktree_and_purge_guards(self):
        def scenario(f):
            f.package.mkdir()
            sentinel = f.package / "foreign.txt"
            sentinel.write_text("keep")
            self.assertNotEqual(f.run("fetch").returncode, 0)
            self.assertEqual(sentinel.read_text(), "keep")
            sentinel.unlink()
            f.package.rmdir()
            self.success(f.run("agents"))
            (f.package / ".git").write_text("gitdir: ../real-worktree\n")
            self.assertNotEqual(f.run("fetch", version="v1.0.1").returncode, 0)
            self.assertTrue((f.package / ".git").is_file())
            requests = f.requests()
            self.assertNotEqual(f.run("uninstall", "agents", "--purge").returncode, 0)
            self.assertEqual(f.requests(), requests)
            self.assertTrue((f.agents / "job-match/SKILL.md").is_file())
        self.each_shell(scenario)

    def test_aside_copies_refresh_and_wget_downloads(self):
        def scenario(f):
            self.success(f.run("aside", extra={"RELEASE_TEST_WGET": "1"}))
            installed = f.aside / "job-match"
            self.assertFalse(installed.is_symlink())
            marker = installed / ".job-kit"
            self.assertEqual(
                _marker_skill_tail(marker.read_text().strip()),
                _marker_skill_tail(str(f.physical / "skill/job-match")),
            )
            self.success(f.run("aside", version="v1.0.1"))
            self.assertEqual(
                _marker_skill_tail(marker.read_text().strip()),
                _marker_skill_tail(str(f.physical / "skill/job-match")),
            )
        self.each_shell(scenario)

    def test_aside_refuses_off_macos_without_an_explicit_root(self):
        if os.name == "nt":
            self.skipTest("Aside installs on Windows")
        if sys.platform == "darwin":
            self.skipTest("Aside installs on macOS")
        def scenario(f):
            result = f.run("aside", extra={"ASIDE_SKILLS": ""})
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Aside is macOS-only", result.stdout + result.stderr)
            self.assertFalse(any(f.aside.iterdir()))
        self.each_shell(scenario)


if __name__ == "__main__":
    unittest.main()
