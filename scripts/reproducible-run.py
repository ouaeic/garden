#!/usr/bin/env python3
"""Record and verify a declared analysis run inside its existing execution sandbox."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import selectors
import time
import stat
import subprocess
import sys
import uuid

FORMAT = "garden-analysis-run-1"
MAX_SPEC_BYTES = 1024 * 1024


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def read_json(filename, limit=MAX_SPEC_BYTES):
    with open(filename, "rb") as handle:
        content = handle.read(limit + 1)
    if len(content) > limit:
        raise ValueError("Analysis JSON exceeds the read limit")
    return json.loads(content)


def exact_keys(value, required, optional=()):
    if (
        not isinstance(value, dict)
        or set(value) - set(required) - set(optional)
        or set(required) - set(value)
    ):
        raise ValueError("Invalid analysis specification fields")


def relative(value):
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise ValueError("A file path must be a nonempty relative path")
    candidate = Path(value)
    if candidate.is_absolute() or ".." in candidate.parts or value == ".":
        raise ValueError("Analysis file paths must stay inside the current directory")
    return str(candidate)


def argv(value):
    if not isinstance(value, list) or not value or len(value) > 8192:
        raise ValueError("A command must be a nonempty argument array")
    if (
        any(
            not isinstance(item, str) or "\0" in item or len(item) > 100000
            for item in value
        )
        or not value[0]
    ):
        raise ValueError("Invalid command argument")
    return value


def paths(value):
    if not isinstance(value, list) or len(value) > 4096:
        raise ValueError(
            "Declare at most 4096 files; large directories should use an archive or workflow manifest"
        )
    result = [relative(item) for item in value]
    if len(set(result)) != len(result):
        raise ValueError("Duplicate declared file")
    return result


def validate(spec):
    exact_keys(
        spec,
        ["command", "sources", "inputs", "outputs", "environment"],
        ["name", "seeds"],
    )
    argv(spec["command"])
    for key in ["sources", "outputs"]:
        spec[key] = paths(spec[key])
    if not spec["sources"] or not spec["outputs"]:
        raise ValueError("Declare source files and expected outputs")
    if not isinstance(spec["inputs"], list) or len(spec["inputs"]) > 4096:
        raise ValueError("Invalid analysis inputs")
    for item in spec["inputs"]:
        exact_keys(item, ["path"], ["sourceUrl", "sha256"])
        item["path"] = relative(item["path"])
        if "sourceUrl" in item:
            from urllib.parse import urlsplit

            if not isinstance(item["sourceUrl"], str):
                raise ValueError("Input source URL must be text")
            url = urlsplit(item["sourceUrl"])
            if (
                len(item["sourceUrl"]) > 8192
                or url.scheme not in ["http", "https"]
                or not url.hostname
                or url.username
                or url.password
            ):
                raise ValueError(
                    "Input source URLs must be HTTP(S) URLs without credentials"
                )
        if "sha256" in item and (
            not isinstance(item["sha256"], str)
            or len(item["sha256"]) != 64
            or any(c not in "0123456789abcdef" for c in item["sha256"])
        ):
            raise ValueError("Invalid input SHA-256")
    input_paths = paths([item["path"] for item in spec["inputs"]])
    env = spec["environment"]
    exact_keys(env, ["lockFiles", "probes"], ["runtimeOnly"])
    if "runtimeOnly" in env and not isinstance(env["runtimeOnly"], bool):
        raise ValueError("runtimeOnly must be a boolean")
    env["lockFiles"] = paths(env["lockFiles"])
    if not env["lockFiles"] and env.get("runtimeOnly") is not True:
        raise ValueError(
            "Declare environment lock files, or explicitly declare runtimeOnly for a standard-library analysis"
        )
    if (
        not isinstance(env["probes"], list)
        or not env["probes"]
        or len(env["probes"]) > 32
    ):
        raise ValueError(
            "Declare version/environment probes for the runtimes and tools used"
        )
    names = set()
    for probe in env["probes"]:
        exact_keys(probe, ["name", "command"])
        if (
            not isinstance(probe["name"], str)
            or not probe["name"]
            or len(probe["name"]) > 120
            or probe["name"] in names
        ):
            raise ValueError("Environment probe names must be nonempty and unique")
        names.add(probe["name"])
        argv(probe["command"])
    files = spec["sources"] + input_paths + env["lockFiles"]
    if len(set(files)) != len(files) or set(files) & set(spec["outputs"]):
        raise ValueError("Source, input, lock and output paths must be distinct")
    if "name" in spec and (
        not isinstance(spec["name"], str) or len(spec["name"]) > 200
    ):
        raise ValueError("Invalid analysis name")
    seeds = spec.get("seeds", {})
    if (
        not isinstance(seeds, dict)
        or len(seeds) > 32
        or any(
            not isinstance(key, str)
            or len(key) > 120
            or not isinstance(value, (str, int))
            or isinstance(value, bool)
            or len(str(value)) > 200
            for key, value in seeds.items()
        )
    ):
        raise ValueError("Seeds must be named string/integer declarations")
    return spec


def checked_path(root, filename):
    target = root / relative(filename)
    current = root
    for part in Path(filename).parts:
        current = current / part
        if current.is_symlink():
            raise ValueError(
                "Declared files cannot traverse symbolic links: " + filename
            )
    if not target.resolve().is_relative_to(root):
        raise ValueError("Declared file escaped the execution directory")
    return target


def parent_descriptor(root, filename):
    parts = Path(relative(filename)).parts
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            nested = os.open(
                part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor
            )
            os.close(descriptor)
            descriptor = nested
        return descriptor, parts[-1]
    except BaseException:
        os.close(descriptor)
        raise


def open_relative(root, filename, flags, mode=0o600):
    parent, name = parent_descriptor(root, filename)
    try:
        return os.open(name, flags | os.O_NOFOLLOW, mode, dir_fd=parent)
    finally:
        os.close(parent)


def stat_stamp(item):
    return (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns, item.st_ctime_ns)


def file_identity(root, filename, cache=None):
    checked_path(root, filename)
    descriptor = open_relative(root, filename, os.O_RDONLY | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("Declared paths must be regular files: " + filename)
        if cache is not None and filename in cache:
            saved_stamp, saved_identity = cache[filename]
            named = checked_path(root, filename).stat()
            if saved_stamp == stat_stamp(before) == stat_stamp(named):
                return dict(saved_identity)
        digest = hashlib.sha256()
        count = 0
        progress_at = time.monotonic() + 30
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            count += len(chunk)
            digest.update(chunk)
            if time.monotonic() >= progress_at:
                print(
                    f"garden-run: hashing {filename}: {count} / {before.st_size} bytes",
                    file=sys.stderr,
                    flush=True,
                )
                progress_at = time.monotonic() + 30
        after = os.fstat(descriptor)
        named = checked_path(root, filename).stat()
        if (
            stat_stamp(before) != stat_stamp(after)
            or stat_stamp(after) != stat_stamp(named)
            or count != after.st_size
        ):
            raise ValueError("Declared file changed while hashing: " + filename)
        result = {"path": filename, "bytes": count, "sha256": digest.hexdigest()}
        if cache is not None:
            cache[filename] = (stat_stamp(after), dict(result))
        return result
    finally:
        os.close(descriptor)


def atomic_write(filename, value):
    parent, name = parent_descriptor(
        Path.cwd().resolve(), str(filename.relative_to(Path.cwd().resolve()))
    )
    staging = ".garden-run-" + str(uuid.uuid4())
    descriptor = os.open(
        staging,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
        dir_fd=parent,
    )
    try:
        with os.fdopen(descriptor, "w") as handle:
            json.dump(value, handle, indent=2, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(staging, name, src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
    finally:
        try:
            os.unlink(staging, dir_fd=parent)
        except FileNotFoundError:
            pass
        os.close(parent)


def stop_group(child):
    # An unreaped leader keeps its process identity reserved during cancellation.
    if child.returncode is not None:
        return
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait()


def probes(spec, root):
    result = []
    remaining = 256 * 1024
    for probe in spec["environment"]["probes"]:
        child = subprocess.Popen(
            probe["command"],
            cwd=root,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        content = bytearray()
        deadline = time.monotonic() + 30
        try:
            with selectors.DefaultSelector() as selector:
                os.set_blocking(child.stdout.fileno(), False)
                selector.register(child.stdout, selectors.EVENT_READ)
                while True:
                    timeout = deadline - time.monotonic()
                    if timeout <= 0:
                        raise ValueError(
                            "Environment probe timed out: " + probe["name"]
                        )
                    if not selector.select(timeout):
                        continue
                    chunk = os.read(child.stdout.fileno(), 65536)
                    if not chunk:
                        break
                    if len(content) + len(chunk) > min(128 * 1024, remaining):
                        raise ValueError(
                            "Environment probe output is too large: " + probe["name"]
                        )
                    content.extend(chunk)
            code = child.wait(timeout=max(0.01, deadline - time.monotonic()))
            if code:
                raise ValueError("Environment probe failed: " + probe["name"])
        finally:
            stop_group(child)
            child.stdout.close()
        remaining -= len(content)
        result.append(
            {
                "name": probe["name"],
                "command": probe["command"],
                "sha256": hashlib.sha256(content).hexdigest(),
                "output": content.decode("utf-8", errors="replace"),
            }
        )
    return result


def capture(spec, root, cache):
    inputs = []
    for item in spec["inputs"]:
        observed = file_identity(root, item["path"], cache)
        if item.get("sha256") and item["sha256"] != observed["sha256"]:
            raise ValueError(
                "Input does not match its expected checksum: " + item["path"]
            )
        if "sourceUrl" in item:
            observed["declaredSourceUrl"] = item["sourceUrl"]
        inputs.append(observed)
    return {
        "sources": [file_identity(root, name, cache) for name in spec["sources"]],
        "inputs": inputs,
        "locks": [
            file_identity(root, name, cache)
            for name in spec["environment"]["lockFiles"]
        ],
        "probes": probes(spec, root),
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "architecture": platform.machine(),
        },
    }


def run(spec, root, filename, previous=None):
    spec = validate(spec)
    filename = checked_path(root, relative(filename))
    reserved = (
        spec["sources"]
        + spec["outputs"]
        + spec["environment"]["lockFiles"]
        + [item["path"] for item in spec["inputs"]]
    )
    if filename == root or str(filename.relative_to(root)) in reserved:
        raise ValueError("The manifest must have its own new file path")
    for output in spec["outputs"]:
        if checked_path(root, output).exists():
            raise ValueError(
                "Output already exists; use a clean run directory: " + output
            )
    # An exclusive intent survives interruption before hashing or launching the command.
    fd = open_relative(
        root, str(filename.relative_to(root)), os.O_WRONLY | os.O_CREAT | os.O_EXCL
    )
    os.close(fd)
    receipt = {
        "format": FORMAT,
        "id": str(uuid.uuid4()),
        "status": "preparing",
        "createdAt": now(),
        "spec": spec,
        "seedCoverage": "declared_by_caller_not_automatically_applied",
        "coverage": "declared_files_and_environment_probes",
        "note": "No automatic dependency installation or source download. Undeclared dependencies, external services and unsaved runtime state are not captured.",
    }
    if previous:
        receipt["replayedFrom"] = previous["id"]
    atomic_write(filename, receipt)
    child = None
    hash_cache = {}
    try:
        print(
            "garden-run: preparing declared inputs and environment",
            file=sys.stderr,
            flush=True,
        )
        before = capture(spec, root, hash_cache)
        receipt["before"] = before
        if previous and previous.get("before") != before:
            raise ValueError(
                "Inputs, source, environment locks, version probes or platform changed; execution refused"
            )
        receipt["status"] = "running"
        receipt["startedAt"] = now()
        atomic_write(filename, receipt)
        print("garden-run: running analysis", file=sys.stderr, flush=True)
        child = subprocess.Popen(spec["command"], cwd=root, start_new_session=True)
        receipt["pid"] = child.pid
        atomic_write(filename, receipt)
        code = child.wait()
        receipt["exitCode"] = code
        receipt["commandFinishedAt"] = now()
        receipt["status"] = "verifying"
        atomic_write(filename, receipt)
        print(
            "garden-run: verifying dependencies and outputs",
            file=sys.stderr,
            flush=True,
        )
        after = capture(spec, root, hash_cache)
        receipt["dependenciesUnchanged"] = before == after
        if not receipt["dependenciesUnchanged"]:
            raise ValueError(
                "Declared input, source or environment changed during execution"
            )
        receipt["outputs"] = [file_identity(root, name) for name in spec["outputs"]]
        receipt["status"] = "completed" if code == 0 else "failed"
        if previous:
            receipt["outputsMatchPrevious"] = receipt["outputs"] == previous.get(
                "outputs"
            )
            if not receipt["outputsMatchPrevious"]:
                receipt["status"] = "failed"
                receipt["error"] = "Output checksums differ from the original run"
                return 2
        return code if code >= 0 else 128 - code
    except BaseException as error:
        receipt["status"] = (
            "interrupted"
            if isinstance(error, (KeyboardInterrupt, InterruptedError))
            else "failed"
        )
        receipt["error"] = str(error)
        raise
    finally:
        if child is not None:
            stop_group(child)
        receipt["finishedAt"] = now()
        atomic_write(filename, receipt)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    launch = sub.add_parser(
        "run", help="Record a declared run in the current directory"
    )
    launch.add_argument("--spec", required=True)
    launch.add_argument("--manifest", required=True)
    replay = sub.add_parser(
        "replay",
        help="Check a saved manifest, then explicitly rerun in a clean directory",
    )
    replay.add_argument("--from-manifest", required=True)
    replay.add_argument("--manifest", required=True)
    args = parser.parse_args()
    root = Path.cwd().resolve()
    if args.action == "run":
        return run(read_json(args.spec), root, args.manifest)
    previous = read_json(args.from_manifest, 64 * 1024 * 1024)
    if (
        previous.get("format") != FORMAT
        or previous.get("status") != "completed"
        or not previous.get("before")
        or not previous.get("outputs")
    ):
        raise ValueError("Replay requires a completed analysis manifest")
    return run(previous["spec"], root, args.manifest, previous)


if __name__ == "__main__":

    def interrupted(signum, _frame):
        raise InterruptedError("Run interrupted by signal " + str(signum))

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        sys.exit(main())
    except (
        ValueError,
        OSError,
        KeyError,
        TypeError,
        subprocess.SubprocessError,
    ) as error:
        print("garden-run: " + str(error), file=sys.stderr)
        sys.exit(1)
