#!/usr/bin/env python3
"""Exercise run receipts with real commands and independent result checks."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
import importlib.util
import zipfile

RUNNER = Path(__file__).with_name("reproducible-run.py").resolve()
PYTHON = sys.executable


class AnalysisRuns(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="garden-repro-")
        self.root = Path(self.directory.name).resolve()
        self.first = self.root / "first"
        self.first.mkdir()
        self.spec = {
            "name": "DNA base counts",
            "command": [PYTHON, "analysis.py"],
            "sources": ["analysis.py"],
            "inputs": [
                {"path": "input.fa", "sourceUrl": "https://example.org/fixture.fa"}
            ],
            "outputs": ["result.json"],
            "seeds": {"none": "deterministic base counting"},
            "environment": {
                "lockFiles": [],
                "runtimeOnly": True,
                "probes": [{"name": "Python", "command": [PYTHON, "--version"]}],
            },
        }
        self.source = """from pathlib import Path
import json
sequence = ''.join(line.strip() for line in Path('input.fa').read_text().splitlines() if not line.startswith('>')).upper()
counts = {base: sequence.count(base) for base in 'ACGTN'}
Path('result.json').write_text(json.dumps({'length': len(sequence), 'counts': counts, 'gc': (counts['G'] + counts['C']) / len(sequence)}, sort_keys=True) + '\\n')
"""
        self.populate(self.first)

    def tearDown(self):
        self.directory.cleanup()

    def populate(self, root):
        (root / "analysis.py").write_text(self.source)
        (root / "input.fa").write_text(">test\nACGTACGN\n")
        (root / "spec.json").write_text(json.dumps(self.spec))

    def invoke(self, root=None, replay=None, **options):
        command = [PYTHON, str(RUNNER)]
        command += (
            ["replay", "--from-manifest", str(replay)]
            if replay
            else ["run", "--spec", "spec.json"]
        )
        return subprocess.run(
            command + ["--manifest", "run.json"],
            cwd=root or self.first,
            capture_output=True,
            text=True,
            timeout=15,
            **options
        )

    def read(self, root=None):
        return json.loads(((root or self.first) / "run.json").read_text())

    def test_hash_cache_reuses_only_unchanged_opened_files(self):
        module_spec = importlib.util.spec_from_file_location("garden_repro", RUNNER)
        module = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(module)
        cache = {}
        with mock.patch.object(module.os, "read", wraps=os.read) as reads:
            first = module.file_identity(self.first, "input.fa", cache)
            self.assertGreater(reads.call_count, 0)
            reads.reset_mock()
            self.assertEqual(module.file_identity(self.first, "input.fa", cache), first)
            self.assertEqual(reads.call_count, 0)
            (self.first / "input.fa").write_text(">changed\nGGGG\n")
            changed = module.file_identity(self.first, "input.fa", cache)
            self.assertGreater(reads.call_count, 0)
            self.assertNotEqual(changed["sha256"], first["sha256"])
            self.assertEqual(
                changed["sha256"],
                hashlib.sha256((self.first / "input.fa").read_bytes()).hexdigest(),
            )

    def test_clean_replay_and_independent_metrics(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads((self.first / "result.json").read_text())
        self.assertEqual(
            output,
            {
                "length": 8,
                "counts": {"A": 2, "C": 2, "G": 2, "T": 1, "N": 1},
                "gc": 0.5,
            },
        )
        receipt = self.read()
        self.assertEqual(receipt["status"], "completed")
        self.assertEqual(receipt["directoryFromManifest"], ".")
        self.assertTrue(receipt["dependenciesUnchanged"])
        self.assertEqual(
            receipt["outputs"][0]["sha256"],
            hashlib.sha256((self.first / "result.json").read_bytes()).hexdigest(),
        )
        self.assertEqual(
            receipt["before"]["inputs"][0]["declaredSourceUrl"],
            "https://example.org/fixture.fa",
        )
        self.assertEqual(
            receipt["seedCoverage"], "declared_by_caller_not_automatically_applied"
        )
        fresh = self.root / "fresh"
        fresh.mkdir()
        self.populate(fresh)
        again = self.invoke(fresh, self.first / "run.json")
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertTrue(self.read(fresh)["outputsMatchPrevious"])
        self.assertEqual(self.read(fresh)["replayedFrom"], receipt["id"])

    def test_nested_manifest_records_execution_directory(self):
        (self.first / "records" / "trial").mkdir(parents=True)
        result = subprocess.run(
            [PYTHON, str(RUNNER), "run", "--spec", "spec.json", "--manifest", "records/trial/run.json"],
            cwd=self.first, capture_output=True, text=True, timeout=15,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads((self.first / "records/trial/run.json").read_text())
        self.assertEqual(receipt["directoryFromManifest"], "../..")
        self.assertEqual(receipt["status"], "completed")

    def test_changed_reference_refuses_before_execution(self):
        self.assertEqual(self.invoke().returncode, 0)
        fresh = self.root / "fresh"
        fresh.mkdir()
        self.populate(fresh)
        (fresh / "input.fa").write_text(">changed\nAAAA\n")
        result = self.invoke(fresh, self.first / "run.json")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("changed; execution refused", result.stderr)
        self.assertFalse((fresh / "result.json").exists())
        self.assertEqual(self.read(fresh)["status"], "failed")

    def test_changed_dependency_probe_refuses_before_execution(self):
        self.spec["environment"]["lockFiles"] = ["environment.lock"]
        self.spec["environment"]["probes"].append(
            {
                "name": "dependency",
                "command": [
                    PYTHON,
                    "-c",
                    "from pathlib import Path; print(Path('installed-version').read_text())",
                ],
            }
        )
        (self.first / "environment.lock").write_text("dependency==1.0\n")
        (self.first / "installed-version").write_text("1.0")
        self.populate(self.first)
        self.assertEqual(self.invoke().returncode, 0)
        fresh = self.root / "fresh"
        fresh.mkdir()
        self.populate(fresh)
        shutil.copyfile(self.first / "environment.lock", fresh / "environment.lock")
        (fresh / "installed-version").write_text("2.0")
        result = self.invoke(fresh, self.first / "run.json")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((fresh / "result.json").exists())

    def test_checks_expected_input_identity(self):
        self.spec["inputs"][0]["sha256"] = "0" * 64
        self.populate(self.first)
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("expected checksum", result.stderr)
        self.assertFalse((self.first / "result.json").exists())

    def test_detects_mutated_input_and_missing_outputs(self):
        for source, error in [
            (
                "from pathlib import Path; Path('input.fa').write_text('mutated')",
                "changed during execution",
            ),
            ("print(42)", "result.json"),
        ]:
            with self.subTest(source=source):
                self.populate(self.first)
                (self.first / "analysis.py").write_text(source)
                result = self.invoke()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(error, self.read()["error"])
                (self.first / "run.json").unlink()

    def test_duplicate_manifest_and_existing_output_never_reexecute(self):
        self.assertEqual(self.invoke().returncode, 0)
        before = (self.first / "run.json").read_bytes()
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Output already exists", result.stderr)
        self.assertEqual((self.first / "run.json").read_bytes(), before)
        (self.first / "result.json").unlink()
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.first / "result.json").exists())
        self.assertEqual((self.first / "run.json").read_bytes(), before)

    def test_output_mismatch_is_not_a_successful_reproduction(self):
        self.source = "from pathlib import Path; import uuid; Path('result.json').write_text(str(uuid.uuid4()))"
        self.populate(self.first)
        self.assertEqual(self.invoke().returncode, 0)
        fresh = self.root / "fresh"
        fresh.mkdir()
        self.populate(fresh)
        result = self.invoke(fresh, self.first / "run.json")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.read(fresh)["status"], "failed")
        self.assertFalse(self.read(fresh)["outputsMatchPrevious"])

    def test_probe_output_is_bounded_and_failure_does_not_run_analysis(self):
        self.spec["environment"]["probes"] = [
            {
                "name": "flood",
                "command": [
                    PYTHON,
                    "-c",
                    'import os;\nwhile True: os.write(1,b"x"*65536)',
                ],
            }
        ]
        self.populate(self.first)
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("too large", result.stderr)
        self.assertFalse((self.first / "result.json").exists())

    def test_sigterm_records_interruption_and_stops_child(self):
        self.source = "from pathlib import Path; import time; Path('started').write_text('yes'); time.sleep(120)"
        self.populate(self.first)
        child = subprocess.Popen(
            [
                PYTHON,
                str(RUNNER),
                "run",
                "--spec",
                "spec.json",
                "--manifest",
                "run.json",
            ],
            cwd=self.first,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        try:
            deadline = time.monotonic() + 8
            while not (self.first / "started").exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue((self.first / "started").exists())
            pid = self.read()["pid"]
            child.send_signal(signal.SIGTERM)
            child.communicate(timeout=4)
            self.assertNotEqual(child.returncode, 0)
            self.assertEqual(self.read()["status"], "interrupted")
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate()

    def test_links_and_path_escape_are_refused(self):
        for filename in ["../input.fa", "/tmp/input.fa"]:
            self.spec["inputs"][0]["path"] = filename
            self.populate(self.first)
            self.assertNotEqual(self.invoke().returncode, 0)
        self.spec["inputs"][0]["path"] = "input.fa"
        self.populate(self.first)
        (self.first / "input.fa").unlink()
        (self.root / "outside.fa").write_text("secret")
        (self.first / "input.fa").symlink_to(self.root / "outside.fa")
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("symbolic links", result.stderr)

    def wheel_recipe(self, dependency=None):
        wheel = self.first / "wheels" / "garden_test_science-1.0-py3-none-any.whl"
        wheel.parent.mkdir()
        with zipfile.ZipFile(wheel, "w") as archive:
            archive.writestr("garden_test_science.py", "VALUE = 42\n")
            archive.writestr("garden_test_science-1.0.dist-info/METADATA",
                "Metadata-Version: 2.1\nName: garden-test-science\nVersion: 1.0\n" +
                ("Requires-Dist: " + dependency + "\n" if dependency else ""))
            archive.writestr("garden_test_science-1.0.dist-info/WHEEL",
                "Wheel-Version: 1.0\nGenerator: Garden test\nRoot-Is-Purelib: true\nTag: py3-none-any\n")
            archive.writestr("garden_test_science-1.0.dist-info/RECORD", "")
        name = str(wheel.relative_to(self.first))
        self.spec["command"] = ["python", "analysis.py"]
        self.spec["environment"] = {
            "lockFiles": [name],
            "probes": [{"name": "Python", "command": ["python", "--version"]}],
            "python": {"interpreter": PYTHON, "directory": ".venv", "wheels": [
                {"path": name, "sha256": hashlib.sha256(wheel.read_bytes()).hexdigest()}
            ]},
        }
        self.source = "import garden_test_science as science\nassert science.VALUE == 42\n" + self.source
        self.populate(self.first)
        return wheel

    def test_wheel_environment_is_built_and_replayed_without_an_index(self):
        wheel = self.wheel_recipe()
        environment = dict(os.environ)
        environment.update({"PIP_TARGET": str(self.root / "escaped"),
            "PIP_INDEX_URL": "http://127.0.0.1:1/forbidden", "PIP_REQUIRE_VIRTUALENV": "true",
            "PYTHONPATH": str(self.root / "injected")})
        (self.root / "injected").mkdir()
        (self.root / "injected" / "garden_test_science.py").write_text("VALUE = -1\n")
        result = self.invoke(env=environment)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertFalse((self.root / "escaped").exists())
        self.assertEqual(self.read()["environmentSetup"]["status"], "ready")
        self.assertEqual(json.loads((self.first / "result.json").read_text())["gc"], 0.5)
        inventory = json.loads(self.read()["before"]["probes"][-1]["output"])
        self.assertIn(["garden-test-science", "1.0"], inventory["packages"])
        fresh = self.root / "fresh"
        fresh.mkdir()
        self.populate(fresh)
        (fresh / "wheels").mkdir()
        shutil.copyfile(wheel, fresh / "wheels" / wheel.name)
        result = self.invoke(fresh, self.first / "run.json", env=environment)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertTrue(self.read(fresh)["outputsMatchPrevious"])
        self.assertTrue((fresh / ".venv" / "bin" / "python").exists())

    def test_corrupt_wheel_is_refused_before_environment_creation(self):
        wheel = self.wheel_recipe()
        wheel.write_bytes(wheel.read_bytes() + b"changed")
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Wheel does not match", result.stderr)
        self.assertFalse((self.first / ".venv").exists())
        self.assertFalse((self.first / "result.json").exists())

    def test_missing_transitive_dependency_never_runs_analysis(self):
        self.wheel_recipe("garden-missing-dependency==1.0")
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.first / "result.json").exists())
        self.assertEqual(self.read()["status"], "failed")
        self.assertEqual(self.read()["environmentSetup"]["status"], "installing")

    def test_existing_or_symlinked_environment_is_never_overwritten(self):
        self.wheel_recipe()
        existing = self.first / ".venv"
        existing.mkdir()
        (existing / "keep").write_text("keep")
        self.assertNotEqual(self.invoke().returncode, 0)
        self.assertEqual((existing / "keep").read_text(), "keep")
        (self.first / "run.json").unlink()
        existing.rename(self.root / "outside")
        existing.symlink_to(self.root / "outside")
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("symbolic links", result.stderr)
        self.assertEqual((self.root / "outside" / "keep").read_text(), "keep")

    def test_changed_replay_source_is_refused_before_environment_creation(self):
        wheel = self.wheel_recipe()
        self.assertEqual(self.invoke().returncode, 0)
        fresh = self.root / "fresh"
        fresh.mkdir()
        self.populate(fresh)
        (fresh / "wheels").mkdir()
        shutil.copyfile(wheel, fresh / "wheels" / wheel.name)
        (fresh / "analysis.py").write_text("raise Exception('must not execute')")
        result = self.invoke(fresh, self.first / "run.json")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((fresh / ".venv").exists())

    def test_interrupted_environment_preparation_stops_its_process(self):
        self.wheel_recipe()
        bootstrap = self.first / "bootstrap"
        bootstrap.write_text("#!/bin/sh\necho $$ > setup.pid\nexec sleep 120\n")
        bootstrap.chmod(0o700)
        self.spec["environment"]["python"]["interpreter"] = str(bootstrap)
        self.populate(self.first)
        child = subprocess.Popen(
            [PYTHON, str(RUNNER), "run", "--spec", "spec.json", "--manifest", "run.json"],
            cwd=self.first, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
        try:
            deadline = time.monotonic() + 8
            marker = self.first / "setup.pid"
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(marker.exists())
            pid = int(marker.read_text())
            child.send_signal(signal.SIGTERM)
            child.communicate(timeout=4)
            self.assertEqual(self.read()["status"], "interrupted")
            self.assertEqual(self.read()["environmentSetup"]["status"], "creating")
            self.assertFalse((self.first / "result.json").exists())
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate()

    def test_recipe_cannot_hide_a_package_or_replace_analysis_files(self):
        self.wheel_recipe()
        invalid = [
            {"directory": "not-excluded"},
            {"directory": "../.venv"},
            {"wheels": [{"path": "outside.whl", "sha256": "a" * 64}]},
            {"wheels": []},
        ]
        original = dict(self.spec["environment"]["python"])
        for change in invalid:
            with self.subTest(change=change):
                self.spec["environment"]["python"] = {**original, **change}
                self.populate(self.first)
                self.assertNotEqual(self.invoke().returncode, 0)
                self.assertFalse((self.first / ".venv").exists())
                self.assertFalse((self.first / "result.json").exists())


if __name__ == "__main__":
    unittest.main()
