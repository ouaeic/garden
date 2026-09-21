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
import tarfile
import io
import csv
import platform
import stat

RUNNER = Path(__file__).with_name("reproducible-run.py").resolve()
PYTHON = sys.executable
R = shutil.which("R")
MICROMAMBA = os.environ.get("GARDEN_TEST_MICROMAMBA")
CC = shutil.which("cc")


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

    def derived(self):
        self.assertEqual(self.invoke().returncode, 0)
        root = self.root / "derived"
        root.mkdir()
        shutil.copyfile(self.first / "result.json", root / "copied-input.json")
        shutil.copyfile(self.first / "run.json", root / "producer.json")
        (root / "analysis.py").write_text(
            "from pathlib import Path\nimport json\n"
            "data=json.loads(Path('copied-input.json').read_text())\n"
            "Path('result.json').write_text(json.dumps({'length': data['length'], 'gc_percent': 100*data['gc']}))\n"
        )
        self.spec["inputs"] = [{
            "path": "copied-input.json", "producer": {
                "manifest": "producer.json", "output": "result.json",
                "sha256": hashlib.sha256((root / "producer.json").read_bytes()).hexdigest(),
            }
        }]
        (root / "spec.json").write_text(json.dumps(self.spec))
        return root

    def test_producer_identity_and_copied_output_survive_clean_replay(self):
        root = self.derived()
        result = self.invoke(root)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads((root / "result.json").read_text()), {"length": 8, "gc_percent": 50.0})
        receipt = self.read(root)
        link = receipt["before"]["inputs"][0]["producer"]
        self.assertEqual(link, {
            **self.spec["inputs"][0]["producer"],
            "runId": self.read()["id"], "name": "DNA base counts",
        })
        fresh = self.root / "replay"
        fresh.mkdir()
        for name in ["analysis.py", "copied-input.json", "producer.json"]:
            shutil.copyfile(root / name, fresh / name)
        replay = self.invoke(fresh, root / "run.json")
        self.assertEqual(replay.returncode, 0, replay.stderr)
        self.assertTrue(self.read(fresh)["outputsMatchPrevious"])
        self.assertEqual(self.read(fresh)["before"]["inputs"][0]["producer"], link)

    def test_producer_drift_or_mismatched_input_refuses_before_execution(self):
        root = self.derived()
        original = (root / "producer.json").read_bytes()
        (root / "producer.json").write_bytes(original + b"\n")
        result = self.invoke(root)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Producer record does not match", result.stderr)
        self.assertFalse((root / "result.json").exists())
        (root / "run.json").unlink()
        (root / "producer.json").write_bytes(original)
        (root / "copied-input.json").write_text('{"length": 999, "gc": 1}')
        result = self.invoke(root)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Input does not match the recorded producer output", result.stderr)
        self.assertFalse((root / "result.json").exists())

    def test_producer_mutation_during_analysis_fails_verification(self):
        root = self.derived()
        with (root / "analysis.py").open("a") as source:
            source.write("Path('producer.json').write_text(Path('producer.json').read_text()+'\\n')\n")
        result = self.invoke(root)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((root / "result.json").exists())
        self.assertEqual(self.read(root)["status"], "failed")
        self.assertIn("Producer record does not match", self.read(root)["error"])
        self.assertNotIn("outputs", self.read(root))

    def test_producer_rejects_unsuccessful_ambiguous_or_inconsistent_evidence(self):
        root = self.derived()
        original = json.loads((root / "producer.json").read_text())
        for patch in [
            {"status": "running"}, {"exitCode": 1}, {"dependenciesUnchanged": False},
            {"outputsMatchPrevious": False}, {"outputs": []},
            {"outputs": original["outputs"] * 2},
            {"outputs": [{**original["outputs"][0], "bytes": 1}]},
            {"outputs": [{**original["outputs"][0], "path": "different.json"}]},
        ]:
            with self.subTest(patch=patch):
                (root / "producer.json").write_text(json.dumps({**original, **patch}))
                self.spec["inputs"][0]["producer"]["sha256"] = hashlib.sha256((root / "producer.json").read_bytes()).hexdigest()
                (root / "spec.json").write_text(json.dumps(self.spec))
                result = self.invoke(root)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((root / "result.json").exists())
                self.assertEqual(self.read(root)["status"], "failed")
                (root / "run.json").unlink()

    def test_producer_never_executes_commands_or_follows_upstream_paths(self):
        root = self.derived()
        producer = json.loads((root / "producer.json").read_text())
        producer["spec"]["command"] = [PYTHON, "-c", "from pathlib import Path; Path('unexpected').touch()"]
        producer["directoryFromManifest"] = "../../outside"
        producer["spec"]["inputs"][0]["producer"] = {
            "manifest": "missing-upstream.json", "output": "input.fa", "sha256": "0" * 64,
        }
        (root / "producer.json").write_text(json.dumps(producer))
        self.spec["inputs"][0]["producer"]["sha256"] = hashlib.sha256((root / "producer.json").read_bytes()).hexdigest()
        (root / "spec.json").write_text(json.dumps(self.spec))
        result = self.invoke(root)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((root / "unexpected").exists())

    def test_producer_paths_and_reads_are_confined_and_bounded(self):
        root = self.derived()
        module_spec = importlib.util.spec_from_file_location("garden_lineage", RUNNER)
        module = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(module)
        with self.assertRaisesRegex(ValueError, "combined read limit"):
            module.read_producer(root, "producer.json", 10)
        (root / "alias.json").symlink_to(root / "producer.json")
        with self.assertRaisesRegex(ValueError, "symbolic links"):
            module.read_producer(root, "alias.json", 100000)
        os.mkfifo(root / "pipe.json")
        with self.assertRaisesRegex(ValueError, "regular files"):
            module.read_producer(root, "pipe.json", 100000)
        self.spec["inputs"][0]["producer"]["manifest"] = "../first/run.json"
        with self.assertRaisesRegex(ValueError, "inside the current directory"):
            module.validate(self.spec)

    def test_producer_read_budget_counts_unique_records_and_detects_inflight_changes(self):
        root = self.derived()
        module_spec = importlib.util.spec_from_file_location("garden_lineage_budget", RUNNER)
        module = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(module)
        shutil.copyfile(root / "copied-input.json", root / "second-input.json")
        self.spec["inputs"].append({**self.spec["inputs"][0], "path": "second-input.json"})
        size = (root / "producer.json").stat().st_size
        with mock.patch.object(module, "MAX_PRODUCER_BYTES", size):
            captured = module.capture_files(self.spec, root, {})
            self.assertEqual(len(captured["inputs"]), 2)
            self.assertEqual(captured["inputs"][0]["producer"], captured["inputs"][1]["producer"])
            shutil.copyfile(root / "producer.json", root / "another-producer.json")
            self.spec["inputs"][1]["producer"] = {**self.spec["inputs"][1]["producer"], "manifest": "another-producer.json"}
            with self.assertRaisesRegex(ValueError, "combined read limit"):
                module.capture_files(self.spec, root, {})
        real_read = os.read
        modified = False
        def changing_read(descriptor, count):
            nonlocal modified
            content = real_read(descriptor, count)
            if not modified:
                modified = True
                with (root / "producer.json").open("ab") as handle:
                    handle.write(b"\n")
            return content
        with mock.patch.object(module.os, "read", side_effect=changing_read):
            with self.assertRaisesRegex(ValueError, "changed while reading"):
                module.read_producer(root, "producer.json", size + 100)
        self.assertTrue(modified)

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

    def test_workspace_group_can_read_records_and_access_rebuilt_environments(self):
        self.wheel_recipe()
        result = self.invoke(umask=0o007)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(stat.S_IMODE((self.first / "run.json").stat().st_mode), 0o660)
        self.assertEqual(stat.S_IMODE((self.first / ".venv").stat().st_mode) & 0o777, 0o770)
        failed = self.root / "failed"
        failed.mkdir()
        self.populate(failed)
        (failed / "input.fa").unlink()
        result = self.invoke(failed, umask=0o007)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.read(failed)["status"], "failed")
        self.assertEqual(stat.S_IMODE((failed / "run.json").stat().st_mode), 0o660)

    @unittest.skipUnless(R, "R is not installed")
    def test_r_rebuilt_library_uses_the_private_workspace_group(self):
        self.r_recipe()
        result = self.invoke(umask=0o007)
        self.assertEqual(result.returncode, 0, result.stderr)
        for directory in [".garden", ".garden/r-library"]:
            self.assertEqual(stat.S_IMODE((self.first / directory).stat().st_mode) & 0o777, 0o770)
        self.assertEqual(stat.S_IMODE((self.first / "run.json").stat().st_mode), 0o660)

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

    def conda_recipe(self, dependency="garden-native-lib >=1.0", modern=False):
        manager = self.first / "manager" / "micromamba"
        manager.parent.mkdir()
        shutil.copyfile(MICROMAMBA, manager)
        manager.chmod(0o755)
        build = self.root / "native-build"
        build.mkdir()
        (build / "lib.c").write_text("int garden_gc(const char*s){int n=0;while(*s){if(*s=='C'||*s=='G')n++;s++;}return n;}")
        (build / "main.c").write_text('#include <stdio.h>\nextern int garden_gc(const char*);int main(int n,char**v){if(n!=2)return 2;printf("%d\\n",garden_gc(v[1]));return 0;}')
        mac = platform.system() == "Darwin"
        library = "libgarden.dylib" if mac else "libgarden.so"
        subprocess.run([CC, "-shared", "-fPIC", str(build / "lib.c"), "-o", str(build / library),
            *(["-Wl,-install_name,@rpath/" + library] if mac else [])], check=True, capture_output=True)
        subprocess.run([CC, str(build / "main.c"), "-L" + str(build), "-lgarden",
            "-Wl,-rpath," + ("@executable_path/../lib" if mac else "$ORIGIN/../lib"),
            "-o", str(build / "garden-native-test")], check=True, capture_output=True)
        archives = self.first / "native-packages"
        archives.mkdir()
        subdir = {("Darwin", "arm64"): "osx-arm64", ("Darwin", "x86_64"): "osx-64",
            ("Linux", "x86_64"): "linux-64", ("Linux", "aarch64"): "linux-aarch64"}[(platform.system(), platform.machine())]
        packages = []
        for name, file, dest, depends in [
            ("garden-native-lib", build / library, "lib/" + library, []),
            ("garden-native-test", build / "garden-native-test", "bin/garden-native-test", [dependency])]:
            filename = archives / (name + "-1.0-0.tar.bz2")
            with tarfile.open(filename, "w:bz2") as tar:
                for entry, content in {"info/index.json": json.dumps({"name": name, "version": "1.0", "build": "0", "build_number": 0, "subdir": subdir, "depends": depends}).encode(),
                    "info/files": (dest + "\n").encode(), dest: file.read_bytes()}.items():
                    item = tarfile.TarInfo(entry)
                    item.size = len(content)
                    item.mode = 0o755 if entry == dest else 0o644
                    tar.addfile(item, io.BytesIO(content))
            if modern:
                converted = subprocess.run([str(manager), "--no-rc", "--no-env", "package", "transmute", str(filename)],
                    cwd=build, capture_output=True, text=True, env={"PATH": os.defpath, "HOME": str(build)})
                self.assertEqual(converted.returncode, 0, converted.stdout + converted.stderr)
                filename = filename.with_name(name + "-1.0-0.conda")
            packages.append({"path": str(filename.relative_to(self.first)), "sha256": hashlib.sha256(filename.read_bytes()).hexdigest()})
        self.spec["environment"] = {
            "lockFiles": [str(manager.relative_to(self.first))] + [item["path"] for item in packages],
            "probes": [{"name": "Native GC tool", "command": ["garden-native-test", "ACGT"]}],
            "conda": {"directory": ".garden/conda", "manager": {"path": str(manager.relative_to(self.first)), "sha256": hashlib.sha256(manager.read_bytes()).hexdigest()}, "packages": packages}}
        self.source = self.source.replace("counts =", "import subprocess\nnative=int(subprocess.check_output(['garden-native-test',sequence]).strip())\ncounts =").replace("(counts['G'] + counts['C'])", "native")
        self.populate(self.first)
        return manager

    @unittest.skipUnless(MICROMAMBA and CC, "Native recipe acceptance needs a declared micromamba binary and C compiler")
    def test_native_environment_rebuilds_compiled_libraries_and_replays(self):
        self.conda_recipe(modern=True)
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        recorded = json.loads((self.first / "run.json").read_text())
        self.assertEqual(recorded["environmentSetups"], [{"kind": "conda_packages", "directory": ".garden/conda", "status": "ready"}])
        self.assertEqual(json.loads((self.first / "result.json").read_text())["gc"], 0.5)
        self.assertEqual(recorded["before"]["probes"][-1]["name"], "Garden rebuilt native environment")
        inventory = json.loads(recorded["before"]["probes"][-1]["output"])
        self.assertEqual({item["name"] for item in inventory}, {"garden-native-lib", "garden-native-test"})
        fresh = self.root / "fresh"
        fresh.mkdir()
        self.populate(fresh)
        for name in ["manager", "native-packages"]:
            shutil.copytree(self.first / name, fresh / name)
        result = self.invoke(fresh, replay=self.first / "run.json")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertTrue(json.loads((fresh / "run.json").read_text())["outputsMatchPrevious"])
        self.assertEqual((fresh / "result.json").read_bytes(), (self.first / "result.json").read_bytes())

    @unittest.skipUnless(MICROMAMBA and CC, "Native recipe acceptance needs a declared micromamba binary and C compiler")
    def test_native_dependency_mismatch_is_refused_before_analysis(self):
        self.conda_recipe("garden-native-lib >=2.0")
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        receipt = json.loads((self.first / "run.json").read_text())
        self.assertEqual(receipt["status"], "failed")
        self.assertIn("incomplete or incompatible", receipt["error"])
        self.assertFalse((self.first / "result.json").exists())

    @unittest.skipUnless(MICROMAMBA and CC, "Native recipe acceptance needs a declared micromamba binary and C compiler")
    def test_native_manager_drift_is_refused_before_installation(self):
        manager = self.conda_recipe()
        manager.write_bytes(manager.read_bytes() + b"changed")
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.first / ".garden").exists())
        self.assertIn("lock changed", json.loads((self.first / "run.json").read_text())["error"])

    @unittest.skipUnless(MICROMAMBA and CC, "Native recipe acceptance needs a declared micromamba binary and C compiler")
    def test_native_preparation_ignores_caller_channels_and_leaves_existing_environments_intact(self):
        self.conda_recipe()
        forbidden = self.root / "not-the-cache"
        result = self.invoke(env={**os.environ, "MAMBA_ROOT_PREFIX": str(forbidden), "CONDA_PKGS_DIRS": str(forbidden), "CONDA_PREFIX": str(forbidden), "CONDARC": str(forbidden)})
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertFalse(forbidden.exists())
        (self.first / "run.json").unlink()
        (self.first / "result.json").unlink()
        sentinel = self.first / ".garden/conda/environment/owner.txt"
        sentinel.write_text("keep")
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sentinel.read_text(), "keep")
        self.assertFalse((self.first / "result.json").exists())

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

    def r_recipe(self, dependency=None, mixed=False, compiled=False):
        archive = self.first / "packages" / "GardenScience_1.0.tar.gz"
        archive.parent.mkdir()
        content = {
            "DESCRIPTION": "Package: GardenScience\nVersion: 1.0\nTitle: Local Analysis Test\nDescription: A deterministic local test package.\nAuthor: Garden Test\nMaintainer: Garden Test <test@example.invalid>\nLicense: MIT\n" + ("Imports: " + dependency + "\n" if dependency else ""),
            "NAMESPACE": "export(gc_fraction)\n",
            "R/science.R": "gc_fraction <- function(sequence) { bases <- strsplit(sequence, '', fixed=TRUE)[[1]]; sum(bases %in% c('G', 'C')) / length(bases) }\n",
        }
        if compiled:
            content["DESCRIPTION"] += "NeedsCompilation: yes\n"
            content["NAMESPACE"] += "useDynLib(GardenScience)\n"
            content["R/science.R"] = "gc_fraction <- function(sequence) .Call('gc_fraction_c', as.character(sequence), PACKAGE='GardenScience')\n"
            content["src/science.c"] = """#include <R.h>
#include <Rinternals.h>
#include <string.h>
SEXP gc_fraction_c(SEXP sequence) {
  const char *text = CHAR(STRING_ELT(sequence, 0));
  size_t length = strlen(text), count = 0;
  for (size_t i = 0; i < length; i++) if (text[i] == 'G' || text[i] == 'C') count++;
  return ScalarReal((double)count / length);
}
"""
        with tarfile.open(archive, "w:gz") as handle:
            for name, text in content.items():
                data = text.encode()
                info = tarfile.TarInfo("GardenScience/" + name)
                info.size = len(data)
                info.mode = 0o644
                handle.addfile(info, io.BytesIO(data))
        name = str(archive.relative_to(self.first))
        if not mixed:
            self.spec["command"] = [R or "R", "--vanilla", "--slave", "-f", "analysis.R"]
            self.spec["sources"] = ["analysis.R"]
            self.spec["outputs"] = ["result.tsv"]
            self.spec["environment"] = {"lockFiles": [], "probes": []}
        self.spec["environment"]["lockFiles"].append(name)
        self.spec["environment"]["probes"].append({"name": "R", "command": [R or "R", "--version"]})
        self.spec["environment"]["r"] = {"interpreter": R or "R", "directory": ".garden/r-library", "packages": [{"path": name, "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}]}
        self.populate(self.first)
        (self.first / "analysis.R").write_text("lines <- readLines('input.fa')\nsequence <- paste(lines[!startsWith(lines, '>')], collapse='')\nutils::write.table(data.frame(length=nchar(sequence),gc=GardenScience::gc_fraction(sequence)), 'result.tsv', sep='\\t', quote=FALSE, row.names=FALSE)\n")
        return archive

    @unittest.skipUnless(R, "R native acceptance runs on the VPS")
    def test_r_archive_rebuild_and_replay_with_clean_profiles(self):
        archive = self.r_recipe()
        poison = self.root / "poison.R"
        poison.write_text("stop('undeclared user profile ran')\n")
        environment = dict(os.environ, R_PROFILE_USER=str(poison), R_PROFILE=str(poison),
            R_LIBS=str(self.root / "outside"), R_LIBS_SITE=str(self.root / "outside"))
        result = self.invoke(env=environment)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(self.read()["environmentSetups"][0]["kind"], "r_archives")
        self.assertEqual(self.read()["environmentSetups"][0]["status"], "ready")
        with (self.first / "result.tsv").open() as handle:
            row = next(csv.DictReader(handle, delimiter="\t"))
        self.assertEqual(int(row["length"]), 8)
        self.assertEqual(float(row["gc"]), 0.5)
        inventory = self.read()["before"]["probes"][-1]["output"]
        self.assertIn('"GardenScience"\t"1.0"\t"reconstructed"', inventory)
        self.assertNotIn(str(self.first), inventory)
        fresh = self.root / "fresh"
        fresh.mkdir()
        for name in ["analysis.R", "input.fa"]:
            shutil.copyfile(self.first / name, fresh / name)
        (fresh / "packages").mkdir()
        shutil.copyfile(archive, fresh / "packages" / archive.name)
        result = self.invoke(fresh, self.first / "run.json", env=environment)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertTrue(self.read(fresh)["outputsMatchPrevious"])
        self.assertEqual(self.read()["before"], self.read(fresh)["before"])

    def test_r_corrupted_archive_is_refused_before_creating_library(self):
        archive = self.r_recipe()
        archive.write_bytes(archive.read_bytes() + b"changed")
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("R archive does not match", result.stderr)
        self.assertFalse((self.first / ".garden").exists())
        self.assertFalse((self.first / "result.tsv").exists())

    def test_r_recipe_refuses_undeclared_archives_and_existing_or_symlinked_libraries(self):
        self.r_recipe()
        recipe = self.spec["environment"]["r"]
        for replacement in [{"directory": "../escape"}, {"directory": "library"}, {"packages": []},
                {"packages": [{"path": "undeclared.tar.gz", "sha256": "a" * 64}]}]:
            with self.subTest(replacement=replacement):
                self.spec["environment"]["r"] = {**recipe, **replacement}
                self.populate(self.first)
                self.assertNotEqual(self.invoke().returncode, 0)
                self.assertFalse((self.first / ".garden").exists())
        self.spec["environment"]["r"] = recipe
        self.populate(self.first)
        library = self.first / ".garden" / "r-library"
        library.mkdir(parents=True)
        (library / "keep").write_text("keep")
        self.assertNotEqual(self.invoke().returncode, 0)
        self.assertEqual((library / "keep").read_text(), "keep")
        (self.first / "run.json").unlink()
        library.rename(self.root / "outside")
        library.symlink_to(self.root / "outside")
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("symbolic links", result.stderr)
        self.assertEqual((self.root / "outside" / "keep").read_text(), "keep")

    @unittest.skipUnless(R, "R native acceptance runs on the VPS")
    def test_r_missing_dependency_does_not_start_analysis(self):
        self.r_recipe("GardenMissingDependency")
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.read()["status"], "failed")
        self.assertEqual(self.read()["environmentSetups"][0]["status"], "installing")
        self.assertFalse((self.first / "result.tsv").exists())

    @unittest.skipUnless(R, "R native acceptance runs on the VPS")
    def test_r_and_python_recipes_preserve_both_environments(self):
        self.wheel_recipe()
        self.r_recipe(mixed=True)
        self.spec["sources"].append("analysis.R")
        self.spec["outputs"].append("result.tsv")
        self.source += "\nimport subprocess\nsubprocess.run([" + repr(R) + ", '--vanilla', '--slave', '-f', 'analysis.R'], check=True)\n"
        self.populate(self.first)
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        setups = self.read()["environmentSetups"]
        self.assertEqual([item["kind"] for item in setups], ["python_wheels", "r_archives"])
        self.assertTrue(all(item["status"] == "ready" for item in setups))
        self.assertEqual([probe["name"] for probe in self.read()["before"]["probes"][-2:]],
            ["Garden rebuilt Python environment", "Garden rebuilt R environment"])
        self.assertEqual(json.loads((self.first / "result.json").read_text())["gc"], 0.5)
        self.assertTrue((self.first / "result.tsv").is_file())

    def test_r_bad_archive_in_mixed_recipe_refuses_before_either_setup(self):
        self.wheel_recipe()
        archive = self.r_recipe(mixed=True)
        archive.write_bytes(archive.read_bytes() + b"changed")
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.first / ".venv").exists())
        self.assertFalse((self.first / ".garden").exists())

    def test_r_interrupted_installation_stops_its_process(self):
        self.r_recipe()
        bootstrap = self.first / "bootstrap"
        bootstrap.write_text("#!/bin/sh\necho $$ > setup.pid\nexec sleep 120\n")
        bootstrap.chmod(0o700)
        self.spec["environment"]["r"]["interpreter"] = str(bootstrap)
        self.populate(self.first)
        child = subprocess.Popen([PYTHON, str(RUNNER), "run", "--spec", "spec.json", "--manifest", "run.json"],
            cwd=self.first, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
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
            self.assertEqual(self.read()["environmentSetups"][0]["status"], "installing")
            self.assertFalse((self.first / "result.tsv").exists())
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate()

    @unittest.skipUnless(R, "R native acceptance runs on the VPS")
    def test_r_compiles_local_source_package_before_analysis(self):
        self.r_recipe(compiled=True)
        self.spec["environment"]["probes"].append({"name": "C compiler", "command": ["cc", "--version"]})
        self.populate(self.first)
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        with (self.first / "result.tsv").open() as handle:
            row = next(csv.DictReader(handle, delimiter="\t"))
        self.assertEqual(int(row["length"]), 8)
        self.assertEqual(float(row["gc"]), 0.5)
        self.assertTrue(self.read()["dependenciesUnchanged"])


if __name__ == "__main__":
    unittest.main()
