"""Exercise browser-channel ownership through isolated native installers.

Copies use the working tree, including new skills, without building an archive.
Only browser discovery and the external driver/CLI operations are stubbed.
"""

import http.server
import os
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path

from test_packaging import _powershell_list, _shell_list
from test_release import _marker_skill_tail, native_shells, shell_path

REPO = Path(__file__).resolve().parents[1]
SOLVER = "captcha-solver"
# macOS app bundles the harness accepts, in probe order. Mirrors have_chromium
# in scripts/browser-use/install.sh; AcceptSetTests keeps both in step.
_ACCEPTED_APPS = ("Google Chrome", "Google Chrome Canary", "Chromium",
                  "Brave Browser", "Microsoft Edge", "Arc", "Comet", "Dia")

BASH_DRIVER = r'''#!/bin/sh
if [ "$#" -eq 5 ] && [ "$1" = skill ] && [ "$2" = install ] &&
   [ "$3" = --path ] && [ "$4" = "$BROWSER_TEST_DRIVER" ] &&
   [ "$5" = --no-install ]; then
  mkdir -p "$4" || exit 1
  printf '%s\n' 'fixture browser-use driver' > "$4/SKILL.md"
  exit 0
fi
echo "unexpected browser-use invocation: $*" >> "$BROWSER_TEST_ERRORS"
exit 97
'''

CMD_DRIVER = r'''@echo off
if not "%~1"=="skill" goto unexpected
if not "%~2"=="install" goto unexpected
if not "%~3"=="--path" goto unexpected
if not "%~4"=="%BROWSER_TEST_DRIVER%" goto unexpected
if not "%~5"=="--no-install" goto unexpected
if not "%~6"=="" goto unexpected
mkdir "%~4" || exit /b 1
echo fixture browser-use driver>"%~4\SKILL.md"
exit /b 0
:unexpected
echo unexpected browser-use invocation: %*>>"%BROWSER_TEST_ERRORS%"
exit /b 97
'''


class BrowserFixture:
    def __init__(self, root, shell):
        self.root = root
        self.kind, self.executable = shell
        self.kit = root / "cached kit"
        self.skills = root / "agent skills"
        self.aside = root / "aside skills"
        self.bin = root / "bin"
        self.errors = root / "unexpected-commands.log"
        for name in ("scripts", "skill"):
            shutil.copytree(REPO / name, self.kit / name,
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "node_modules"))
        for path in (self.skills, self.aside, self.bin, root / "home",
                     root / "program files", root / "program files x86",
                     root / "localappdata", root / "config", root / "data"):
            path.mkdir(parents=True, exist_ok=True)
        self.stub("browser-use", BASH_DRIVER, CMD_DRIVER)
        self.stub("uv", r'''#!/bin/sh
if [ "$#" -eq 3 ] && [ "$1" = tool ] && [ "$2" = uninstall ] &&
   [ "$3" = browser-use ]; then exit 0; fi
echo "unexpected uv invocation: $*" >> "$BROWSER_TEST_ERRORS"
exit 97
''', r'''@echo off
if not "%~1"=="tool" goto unexpected
if not "%~2"=="uninstall" goto unexpected
if not "%~3"=="browser-use" goto unexpected
if not "%~4"=="" goto unexpected
exit /b 0
:unexpected
echo unexpected uv invocation: %*>>"%BROWSER_TEST_ERRORS%"
exit /b 97
''')
        # Discovery checks only command presence; running a browser is a bug.
        for name in ("google-chrome", "chromium"):
            self.stub(name, '#!/bin/sh\necho "unexpected browser invocation" >> "$BROWSER_TEST_ERRORS"\nexit 97\n',
                      '@echo off\necho unexpected browser invocation>>"%BROWSER_TEST_ERRORS%"\nexit /b 97\n')

    def stub(self, name, bash, cmd):
        path = self.bin / name
        with path.open("w", encoding="utf-8", newline="\n") as stream:
            stream.write(bash)
        path.chmod(0o755)
        with (self.bin / (name + ".cmd")).open("w", encoding="utf-8", newline="\r\n") as stream:
            stream.write(cmd)

    def run(self, entrypoint, *args, override=True):
        excluded = {"HOME", "USERPROFILE", "CLAUDE_SKILLS", "ASIDE_SKILLS",
                    "BASH_ENV", "ENV", "PSMODULEPATH", "XDG_CONFIG_HOME",
                    "XDG_DATA_HOME", "LOCALAPPDATA", "APPDATA", "PROGRAMFILES",
                    "PROGRAMFILES(X86)"}
        env = {key: value for key, value in os.environ.items()
               if key.upper() not in excluded
               and not key.upper().startswith(("JOB_KIT_", "ASIDE_", "BROWSER_TEST_", "XDG_"))}
        paths = {
            "HOME": self.root / "home", "USERPROFILE": self.root / "home",
            "ASIDE_SKILLS": self.aside,
            "JOB_KIT_HOME": self.kit, "XDG_CONFIG_HOME": self.root / "config",
            "XDG_DATA_HOME": self.root / "data", "APPDATA": self.root / "config",
            "LOCALAPPDATA": self.root / "localappdata",
            "ProgramFiles": self.root / "program files",
            "ProgramFiles(x86)": self.root / "program files x86",
            "BROWSER_TEST_DRIVER": self.skills / "browser-use",
            "BROWSER_TEST_ERRORS": self.errors,
        }
        env.update({key: shell_path(path, self.kind) for key, path in paths.items()})
        if override:
            env["CLAUDE_SKILLS"] = shell_path(self.skills, self.kind)
        env["PATH"] = str(self.bin) + os.pathsep + os.environ.get("PATH", "")
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        suffix = ".sh" if self.kind == "bash" else ".ps1"
        script = self.kit / "scripts" / (entrypoint + suffix) if entrypoint is not None else None
        if self.kind == "bash":
            if os.name == "nt":
                env["MSYS"] = "winsymlinks:nativestrict"
            command = [self.executable, shell_path(script, self.kind), *args]
        else:
            command = [self.executable, "-NoLogo", "-NoProfile", "-NonInteractive",
                       "-ExecutionPolicy", "Bypass"]
            command += ["-Command", "exit 0"] if script is None else ["-File", str(script), *args]
        return subprocess.run(command, cwd=self.root, env=env, input="",
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=90)

    def names(self):
        return {path.name for path in self.skills.iterdir()}

    def link_solver(self):
        source = self.kit / "skill" / SOLVER
        dest = self.skills / SOLVER
        if os.name == "nt":
            subprocess.run(["cmd", "/c", "mklink", "/J", str(dest), str(source)],
                           check=True, capture_output=True)
        else:
            dest.symlink_to(source, target_is_directory=True)


class BrowserChannelTests(unittest.TestCase):
    def each_shell(self, scenario):
        shells = native_shells()
        self.assertTrue(shells, "no native installer shell found")
        for shell in shells:
            with self.subTest(shell=shell[0]), tempfile.TemporaryDirectory() as directory:
                fixture = BrowserFixture(Path(directory).resolve(), shell)
                try:
                    scenario(fixture)
                finally:
                    self.assertFalse(fixture.errors.exists(),
                                     fixture.errors.read_text() if fixture.errors.exists() else "")

    def success(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_dry_runs_select_solver_only_for_browser(self):
        def scenario(f):
            if f.kind != "bash":
                # PowerShell initializes its user directories on first launch.
                self.success(f.run(None))
            before = sorted(str(path.relative_to(f.root)) for path in f.root.rglob("*"))
            browser = f.run("browser-use/install", "--dry-run")
            agents = f.run("agents/install", "--dry-run")
            self.success(browser)
            self.success(agents)
            self.assertIn(SOLVER, browser.stdout)
            self.assertNotIn(SOLVER, agents.stdout)
            self.assertEqual(f.names(), set())
            self.assertEqual(before, sorted(str(path.relative_to(f.root)) for path in f.root.rglob("*")))
        self.each_shell(scenario)

    def test_browser_only_cycle_removes_all_skills(self):
        def scenario(f):
            self.success(f.run("browser-use/install"))
            self.assertTrue((f.skills / SOLVER / "SKILL.md").is_file())
            self.assertEqual((f.skills / SOLVER).resolve(), (f.kit / "skill" / SOLVER).resolve())
            self.assertTrue((f.skills / "browser-use/SKILL.md").is_file())
            self.success(f.run("uninstall", "browser-use"))
            self.assertEqual(f.names(), set())
        self.each_shell(scenario)

    def test_agents_only_cycle_never_installs_solver(self):
        def scenario(f):
            self.success(f.run("agents/install"))
            self.assertNotIn(SOLVER, f.names())
            self.assertNotIn("browser-use", f.names())
            self.assertIn("job-profile", f.names())
            self.success(f.run("uninstall", "agents"))
            self.assertEqual(f.names(), set())
        self.each_shell(scenario)

    def test_browser_uninstall_preserves_only_agents_dependencies(self):
        def scenario(f):
            self.success(f.run("agents/install"))
            self.success(f.run("browser-use/install"))
            self.assertTrue((f.skills / SOLVER / "SKILL.md").is_file())
            before = f.names()
            preview = f.run("uninstall", "browser-use", "--dry-run")
            self.success(preview)
            self.assertIn(SOLVER, preview.stdout)
            self.assertNotIn("job-match", preview.stdout)
            self.assertEqual(f.names(), before)
            self.success(f.run("uninstall", "browser-use"))
            self.assertEqual(before - f.names(),
                             {SOLVER, "job-scout", "job-apply", "job-prep", "browser-use"})
            self.assertIn("job-match", f.names())
            self.assertIn("job-profile", f.names())
            self.success(f.run("uninstall", "agents"))
            self.assertEqual(f.names(), set())
        self.each_shell(scenario)

    def test_agents_removal_preserves_browser_dependencies(self):
        def scenario(f):
            self.success(f.run("agents/install"))
            self.success(f.run("browser-use/install"))
            self.success(f.run("uninstall", "agents"))
            self.assertIn(SOLVER, f.names())
            self.assertIn("job-match", f.names())
            self.assertIn("job-apply", f.names())
            self.assertIn("job-profile", f.names())
            self.success(f.run("uninstall", "browser-use"))
            self.assertEqual(f.names(), set())
        self.each_shell(scenario)

    def test_sole_solver_link_blocks_cache_purge(self):
        def scenario(f):
            f.link_solver()
            self.assertEqual(f.names(), {SOLVER})
            result = f.run("uninstall", "cache", "--dry-run")
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn(SOLVER, result.stdout + result.stderr)
            self.assertIn("installed skills point at", result.stdout + result.stderr)
            self.assertTrue(f.kit.is_dir())
            self.assertEqual(f.names(), {SOLVER})
        self.each_shell(scenario)

    def test_aside_copies_block_cache_purge(self):
        def scenario(f):
            self.success(f.run("aside/install"))
            self.assertIn("job-match", {path.name for path in f.aside.iterdir()})
            result = f.run("uninstall", "cache", "--dry-run")
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("job-match", result.stdout + result.stderr)
            self.assertIn("installed skills point at", result.stdout + result.stderr)
            self.assertTrue(f.kit.is_dir())
            self.assertIn("job-match", {path.name for path in f.aside.iterdir()})
        self.each_shell(scenario)

    def test_aside_dry_run_copies_nothing(self):
        def scenario(f):
            if f.kind != "bash":
                self.success(f.run(None))
            before = sorted(str(path.relative_to(f.root)) for path in f.root.rglob("*"))
            result = f.run("aside/install", "--dry-run")
            self.success(result)
            self.assertEqual({path.name for path in f.aside.iterdir()}, set())
            self.assertEqual(before, sorted(str(path.relative_to(f.root)) for path in f.root.rglob("*")))
        self.each_shell(scenario)

    def test_aside_copies_with_marker(self):
        def scenario(f):
            self.success(f.run("aside/install"))
            installed = f.aside / "job-match"
            self.assertTrue((installed / "SKILL.md").is_file())
            self.assertFalse(installed.is_symlink())
            if hasattr(installed, "is_junction"):
                self.assertFalse(installed.is_junction())
            marker = installed / ".job-kit"
            self.assertEqual(
                _marker_skill_tail(marker.read_text(encoding="utf-8").strip()),
                _marker_skill_tail(str(f.kit / "skill" / "job-match")),
            )
            self.assertFalse((f.aside / SOLVER).exists())
            self.success(f.run("aside/install"))
            self.assertEqual(
                _marker_skill_tail(marker.read_text(encoding="utf-8").strip()),
                _marker_skill_tail(str(f.kit / "skill" / "job-match")),
            )
            self.success(f.run("uninstall", "aside"))
            self.assertEqual({path.name for path in f.aside.iterdir()}, set())
        self.each_shell(scenario)

    def test_aside_foreign_blocks(self):
        def scenario(f):
            dest = f.aside / "job-match"
            dest.mkdir()
            (dest / "SKILL.md").write_text("foreign", encoding="utf-8")
            result = f.run("aside/install")
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("foreign", result.stdout + result.stderr)
            self.assertIn("rm -rf" if f.kind == "bash" else "Remove-Item", result.stdout)
            self.assertEqual((dest / "SKILL.md").read_text(encoding="utf-8"), "foreign")
        self.each_shell(scenario)

    def test_aside_stale_copy_refreshes(self):
        def scenario(f):
            dest = f.aside / "job-match"
            dest.mkdir()
            (dest / "SKILL.md").write_text("old", encoding="utf-8")
            (dest / ".job-kit").write_text(str(f.root / "moved" / "skill" / "job-match") + "\n", encoding="utf-8")
            self.success(f.run("aside/install"))
            self.assertEqual(
                _marker_skill_tail((dest / ".job-kit").read_text(encoding="utf-8").strip()),
                _marker_skill_tail(str(f.kit / "skill" / "job-match")),
            )
        self.each_shell(scenario)

    def test_aside_stale_windows_marker_refreshes(self):
        def scenario(f):
            dest = f.aside / "job-match"
            dest.mkdir()
            (dest / "SKILL.md").write_text("old", encoding="utf-8")
            (dest / ".job-kit").write_text("C:\\gone\\moved\\skill\\job-match\n", encoding="utf-8")
            self.success(f.run("aside/install"))
            self.assertEqual(
                _marker_skill_tail((dest / ".job-kit").read_text(encoding="utf-8").strip()),
                _marker_skill_tail(str(f.kit / "skill" / "job-match")),
            )
        self.each_shell(scenario)

    def test_claude_worker_agent_cycle(self):
        def scenario(f):
            (f.root / "home" / ".claude").mkdir()
            source = f.kit / "skill/job-match/agents/job-kit-worker.md"
            dest = f.root / "home/.claude/agents/job-kit-worker.md"
            self.success(f.run("agents/install", "--dry-run", override=False))
            self.assertFalse(dest.exists())
            self.success(f.run("agents/install", override=False))
            self.assertEqual(dest.read_bytes(), source.read_bytes())
            dest.write_text(source.read_text() + "\n# stale\n")
            self.success(f.run("agents/install", override=False))
            self.assertEqual(dest.read_bytes(), source.read_bytes())
            self.success(f.run("uninstall", "agents", override=False))
            self.assertFalse(dest.exists())
            dest.write_text("mine\n")
            self.assertNotEqual(f.run("agents/install", override=False).returncode, 0)
            self.success(f.run("uninstall", "agents", override=False))
            self.assertEqual(dest.read_text(), "mine\n")
        self.each_shell(scenario)

    def test_agents_stale_link_relinks(self):
        def scenario(f):
            gone = f.root / "moved" / "skill" / "job-profile"
            gone.mkdir(parents=True)
            f.skills.mkdir(exist_ok=True)
            dest = f.skills / "job-profile"
            if os.name == "nt":
                subprocess.run(["cmd", "/c", "mklink", "/J", str(dest), str(gone)],
                               check=True, capture_output=True)
            else:
                dest.symlink_to(gone, target_is_directory=True)
            shutil.rmtree(f.root / "moved")
            self.success(f.run("agents/install"))
            self.assertTrue((dest / "SKILL.md").is_file())
        self.each_shell(scenario)

    def test_install_router_aside(self):
        def scenario(f):
            self.success(f.run("install", "aside"))
            installed = f.aside / "job-match"
            self.assertTrue((installed / "SKILL.md").is_file())
            self.assertFalse(installed.is_symlink())
            self.assertEqual(
                _marker_skill_tail((installed / ".job-kit").read_text(encoding="utf-8").strip()),
                _marker_skill_tail(str(f.kit / "skill" / "job-match")),
            )
        self.each_shell(scenario)

    def test_install_all_copies_aside(self):
        def scenario(f):
            self.success(f.run("install", "all"))
            installed = f.aside / "job-match"
            self.assertTrue((installed / "SKILL.md").is_file())
            self.assertFalse(installed.is_symlink())
            self.assertIn("job-profile", f.names())
            self.assertIn("job-scout", f.names())
        self.each_shell(scenario)


class BrowserDependencyTests(unittest.TestCase):
    def test_shell_lists_agree_and_solver_is_browser_exclusive(self):
        bash = (REPO / "scripts/agents/lib.sh").read_text(encoding="utf-8")
        powershell = (REPO / "scripts/agents/lib.ps1").read_text(encoding="utf-8")
        for sh_name, ps_name in (
            ("CORE_SKILL_NAMES", "CoreSkillNames"),
            ("SKILL_NAMES", "SkillNames"),
            ("BROWSER_SKILL_NAMES", "BrowserSkillNames"),
            ("BROWSER_SHARED_DEPS", "BrowserSharedDeps"),
            ("ALL_SKILL_NAMES", "AllSkillNames"),
        ):
            with self.subTest(list=sh_name):
                entries = _shell_list(bash, sh_name)
                self.assertTrue(entries)
                self.assertEqual(entries, _powershell_list(powershell, ps_name))
                self.assertEqual(SOLVER in entries,
                                 sh_name in ("BROWSER_SHARED_DEPS", "ALL_SKILL_NAMES"))
        aside = (REPO / "scripts/aside/lib.sh").read_text(encoding="utf-8")
        self.assertNotIn(SOLVER, _shell_list(aside, "SKILL_NAMES"))
        self.assertNotIn("captcha-solver", _shell_list(aside, "SKILL_NAMES"))
        aside_ps = (REPO / "scripts/aside/lib.ps1").read_text(encoding="utf-8")
        self.assertEqual(_shell_list(aside, "SKILL_NAMES"),
                         _powershell_list(aside_ps, "AsideSkillNames"))
        self.assertEqual(_shell_list(aside, "LEGACY_SKILL_NAMES"),
                         _powershell_list(aside_ps, "AsideLegacySkillNames"))
        self.assertNotIn(SOLVER, _powershell_list(aside_ps, "AsideSkillNames"))


class _VersionHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200 if self.path == "/json/version" else 404)
        self.end_headers()
        self.wfile.write(b'{"webSocketDebuggerUrl": "ws://fixture"}')

    def log_message(self, *args):
        pass


def _app_names(path):
    """App bundle names a script probes, in probe order; empty when it has none."""
    text = (REPO / path).read_text(encoding="utf-8")
    if "for app in" not in text:
        return ()
    body = text.split("for app in", 1)[1].split("; do", 1)[0]
    return tuple(re.findall(r'"([^"]+)"', body))


class AcceptSetTests(unittest.TestCase):
    def test_launcher_accepts_every_browser_preflight_accepts(self):
        """A browser that passes preflight must be one the helper can start.

        The launcher probes the real /Applications, so no sandbox can prove the
        selection end to end; pinning both lists against one another is what
        keeps them from drifting.
        """
        self.assertEqual(_app_names("scripts/browser-use/install.sh"),
                         _ACCEPTED_APPS)
        self.assertEqual(_app_names("scripts/browser-use/chrome.sh"),
                         _ACCEPTED_APPS)


@unittest.skipIf(os.name == "nt", "chrome.sh is a POSIX helper")
class DedicatedChromeTests(unittest.TestCase):
    def test_reuses_a_listening_chrome_without_launching(self):
        server = http.server.HTTPServer(("127.0.0.1", 0), _VersionHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        port = server.server_address[1]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            launches = root / "launches.log"
            for name in ("open", "google-chrome", "chromium"):
                stub = root / name
                stub.write_text(f'#!/bin/sh\necho "$0 $*" >> "{launches}"\n',
                                encoding="utf-8")
                stub.chmod(0o755)
            env = dict(os.environ, BU_CHROME_PORT=str(port),
                       XDG_CONFIG_HOME=str(root / "config"),
                       PATH=f"{root}{os.pathsep}{os.environ['PATH']}")
            result = subprocess.run(
                ["bash", str(REPO / "scripts/browser-use/chrome.sh")],
                env=env, capture_output=True, text=True, check=True)
            self.assertIn(f"export BU_CDP_URL=http://127.0.0.1:{port}", result.stdout)
            self.assertFalse(launches.exists())

    def test_launches_the_resolved_browser_with_the_debug_flags(self):
        """Cover the launch branch: the Darwin path had no coverage at all.

        The stub launcher starts nothing, so chrome.sh polls the dead port and
        exits on its own timeout. That keeps the test free of a fixture server
        racing for a preallocated port, and covers the timeout branch too.
        `expected` re-derives the pick from the accept-set, so where no host
        bundle exists — Linux CI — it is the fixture Brave and a launcher
        hardcoded to Google Chrome fails here.
        """
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            launches = root / "launches.log"
            (root / "Applications/Brave Browser.app").mkdir(parents=True)
            expected = "Brave Browser"
            for app in _ACCEPTED_APPS:
                if Path(f"/Applications/{app}.app").is_dir():
                    expected = app
                    break
            (root / "uname").write_text("#!/bin/sh\necho Darwin\n", encoding="utf-8")
            (root / "open").write_text(
                f'#!/bin/sh\nfor arg in "$@"; do echo "$arg" >> "{launches}"; done\n',
                encoding="utf-8")
            for name in ("google-chrome", "chromium"):
                (root / name).write_text(
                    f'#!/bin/sh\necho "$0" >> "{launches}"\n', encoding="utf-8")
            for name in ("uname", "open", "google-chrome", "chromium"):
                (root / name).chmod(0o755)
            env = dict(os.environ, BU_CHROME_PORT=str(port), HOME=str(root),
                       XDG_CONFIG_HOME=str(root / "config"),
                       PATH=f"{root}{os.pathsep}{os.environ['PATH']}")
            result = subprocess.run(
                ["bash", str(REPO / "scripts/browser-use/chrome.sh")],
                env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn(f"did not answer on http://127.0.0.1:{port}",
                          result.stderr)
            self.assertTrue(launches.exists(), "no launcher was invoked")
            argv = launches.read_text(encoding="utf-8").splitlines()
            self.assertEqual(argv[:3], ["-na", expected, "--args"])
            self.assertEqual(sorted(argv[3:]), sorted([
                f"--remote-debugging-port={port}",
                f"--user-data-dir={root}/config/browser-harness/chrome-profile",
                "--no-first-run", "--no-default-browser-check"]))


if __name__ == "__main__":
    unittest.main()
