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
import re

FORMAT = "garden-analysis-run-1"
MAX_SPEC_BYTES = 1024 * 1024
MAX_PRODUCER_BYTES = 64 * 1024 * 1024


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
    if (
        candidate.is_absolute()
        or ".." in candidate.parts
        or value == "."
        or "\0" in value
        or "\\" in value
    ):
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
        exact_keys(item, ["path"], ["sourceUrl", "sha256", "producer"])
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
        if "producer" in item:
            producer = item["producer"]
            exact_keys(producer, ["manifest", "sha256", "output"])
            producer["manifest"] = relative(producer["manifest"])
            producer["output"] = relative(producer["output"])
            if not isinstance(producer["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", producer["sha256"]):
                raise ValueError("A producer record needs its expected SHA-256")
    input_paths = paths([item["path"] for item in spec["inputs"]])
    env = spec["environment"]
    exact_keys(env, ["lockFiles", "probes"], ["runtimeOnly", "python", "r"])
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
            or ("python" in env and probe["name"] == "Garden rebuilt Python environment")
            or ("r" in env and probe["name"] == "Garden rebuilt R environment")
        ):
            raise ValueError("Environment probe names must be nonempty and unique")
        names.add(probe["name"])
        argv(probe["command"])
    files = spec["sources"] + input_paths + env["lockFiles"]
    if len(set(files)) != len(files) or set(files) & set(spec["outputs"]):
        raise ValueError("Source, input, lock and output paths must be distinct")
    producer_paths = {item["producer"]["manifest"] for item in spec["inputs"] if "producer" in item}
    if producer_paths & set(spec["outputs"]):
        raise ValueError("Producer records cannot be analysis outputs")
    files += sorted(producer_paths)
    if "python" in env:
        recipe = env["python"]
        exact_keys(recipe, ["interpreter", "directory", "wheels"])
        argv([recipe["interpreter"]])
        recipe["directory"] = relative(recipe["directory"])
        if env.get("runtimeOnly"):
            raise ValueError("A package environment cannot be runtimeOnly")
        if not isinstance(recipe["wheels"], list) or not 0 < len(recipe["wheels"]) <= 4096:
            raise ValueError("Declare the complete nonempty wheel set")
        wheels = set()
        for wheel in recipe["wheels"]:
            exact_keys(wheel, ["path", "sha256"])
            wheel["path"] = relative(wheel["path"])
            if (
                wheel["path"] in wheels
                or wheel["path"] not in env["lockFiles"]
                or not wheel["path"].endswith(".whl")
                or not isinstance(wheel["sha256"], str)
                or not re.fullmatch(r"[a-f0-9]{64}", wheel["sha256"])
            ):
                raise ValueError("Each wheel needs a unique declared lock path and SHA-256")
            wheels.add(wheel["path"])
        directory = Path(recipe["directory"])
        if directory.name != ".venv":
            raise ValueError("Use a .venv directory so package files stay outside project snapshots")
        if any(Path(name).is_relative_to(directory) for name in files + spec["outputs"]):
            raise ValueError("The disposable environment cannot contain declared analysis files")
    if "r" in env:
        recipe = env["r"]
        exact_keys(recipe, ["interpreter", "directory", "packages"])
        argv([recipe["interpreter"]])
        recipe["directory"] = relative(recipe["directory"])
        directory = Path(recipe["directory"])
        if tuple(directory.parts[-2:]) != (".garden", "r-library"):
            raise ValueError("Use a .garden/r-library directory outside project snapshots")
        if env.get("runtimeOnly"):
            raise ValueError("A package environment cannot be runtimeOnly")
        if not isinstance(recipe["packages"], list) or not 0 < len(recipe["packages"]) <= 4096:
            raise ValueError("Declare the complete nonempty R package archive set")
        archives = set()
        for package in recipe["packages"]:
            exact_keys(package, ["path", "sha256"])
            package["path"] = relative(package["path"])
            if (
                package["path"] in archives
                or package["path"] not in env["lockFiles"]
                or not package["path"].endswith(".tar.gz")
                or not isinstance(package["sha256"], str)
                or not re.fullmatch(r"[a-f0-9]{64}", package["sha256"])
            ):
                raise ValueError("Each R archive needs a unique declared lock path and SHA-256")
            archives.add(package["path"])
        if any(Path(name).is_relative_to(directory.parent) for name in files + spec["outputs"]):
            raise ValueError("The disposable R environment cannot contain declared analysis files")
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


def probes(spec, root, execution_env=None):
    result = []
    remaining = 256 * 1024
    declared = list(spec["environment"]["probes"])
    recipe = spec["environment"].get("python")
    if recipe:
        declared.append(
            {
                "name": "Garden rebuilt Python environment",
                "command": [
                    str(Path(recipe["directory"]) / "bin/python"), "-I", "-c",
                    "import sys,json,importlib.metadata as m; "
                    "print(json.dumps({'python':sys.version,"
                    "'implementation':sys.implementation.name,"
                    "'packages':sorted((d.metadata['Name'],d.version) "
                    "for d in m.distributions())},sort_keys=True))",
                ],
            }
        )
    r_recipe = spec["environment"].get("r")
    if r_recipe:
        declared.append({
            "name": "Garden rebuilt R environment",
            "command": [r_recipe["interpreter"], "--vanilla", "--slave", "-e", R_INVENTORY],
        })
    for probe in declared:
        child = subprocess.Popen(
            probe["command"],
            cwd=root,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            env=execution_env,
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


def capture_files(spec, root, cache):
    inputs = []
    producers = {}
    producer_bytes = 0
    for item in spec["inputs"]:
        observed = file_identity(root, item["path"], cache)
        if item.get("sha256") and item["sha256"] != observed["sha256"]:
            raise ValueError(
                "Input does not match its expected checksum: " + item["path"]
            )
        if "sourceUrl" in item:
            observed["declaredSourceUrl"] = item["sourceUrl"]
        if "producer" in item:
            declared = item["producer"]
            filename = declared["manifest"]
            if filename not in producers:
                producer, identity = read_producer(root, filename, MAX_PRODUCER_BYTES - producer_bytes)
                producer_bytes += identity["bytes"]
                producers[filename] = (producer, identity)
            producer, identity = producers[filename]
            if identity["sha256"] != declared["sha256"]:
                raise ValueError("Producer record does not match its expected checksum: " + filename)
            output = producer["outputs"].get(declared["output"])
            if output is None or (output["sha256"], output["bytes"]) != (observed["sha256"], observed["bytes"]):
                raise ValueError("Input does not match the recorded producer output: " + item["path"])
            observed["producer"] = {
                "manifest": filename, "sha256": identity["sha256"],
                "output": declared["output"], "runId": producer["id"],
                **({"name": producer["name"]} if producer.get("name") else {}),
            }
        inputs.append(observed)
    return {
        "sources": [file_identity(root, name, cache) for name in spec["sources"]],
        "inputs": inputs,
        "locks": [
            file_identity(root, name, cache)
            for name in spec["environment"]["lockFiles"]
        ],
    }


def read_producer(root, filename, remaining):
    """Read only the explicitly named receipt; upstream files and commands are never followed."""
    checked_path(root, filename)
    descriptor = open_relative(root, filename, os.O_RDONLY | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("Producer records must be regular files: " + filename)
        if before.st_size > remaining:
            raise ValueError("Producer records exceed the combined read limit")
        chunks = []
        size = 0
        digest = hashlib.sha256()
        while True:
            chunk = os.read(descriptor, min(1024 * 1024, remaining - size + 1))
            if not chunk:
                break
            size += len(chunk)
            if size > remaining:
                raise ValueError("Producer records exceed the combined read limit")
            chunks.append(chunk)
            digest.update(chunk)
        after = os.fstat(descriptor)
        named = checked_path(root, filename).stat()
        if stat_stamp(before) != stat_stamp(after) or stat_stamp(after) != stat_stamp(named) or size != after.st_size:
            raise ValueError("Producer record changed while reading: " + filename)
        record = json.loads(b"".join(chunks))
    finally:
        os.close(descriptor)
    if (
        not isinstance(record, dict) or record.get("format") != FORMAT
        or record.get("status") != "completed" or record.get("exitCode") != 0
        or record.get("dependenciesUnchanged") is not True
        or record.get("outputsMatchPrevious") is False
    ):
        raise ValueError("A producer must be a completed successful analysis record: " + filename)
    uuid.UUID(record["id"])
    parent_spec = validate(record["spec"])
    recorded = record.get("outputs")
    if not isinstance(recorded, list) or not recorded or len(recorded) > 4096:
        raise ValueError("Producer output evidence is missing or invalid: " + filename)
    outputs = {}
    for output in recorded:
        if (
            not isinstance(output, dict) or not isinstance(output.get("sha256"), str)
            or not re.fullmatch(r"[a-f0-9]{64}", output["sha256"])
            or type(output.get("bytes")) is not int or output["bytes"] < 0
        ):
            raise ValueError("Producer output identity is invalid: " + filename)
        name = relative(output["path"])
        if name in outputs:
            raise ValueError("Producer output identities are ambiguous: " + filename)
        outputs[name] = output
    if set(outputs) != set(parent_spec["outputs"]):
        raise ValueError("Producer evidence does not match its declared outputs: " + filename)
    return {"id": record["id"], "name": parent_spec.get("name"), "outputs": outputs}, {
        "bytes": size, "sha256": digest.hexdigest()
    }


def capture(spec, root, cache, execution_env=None):
    return {
        **capture_files(spec, root, cache),
        "probes": probes(spec, root, execution_env),
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "architecture": platform.machine(),
        },
    }


def setup_command(command, root, execution_env):
    child = subprocess.Popen(command, cwd=root, env=execution_env, start_new_session=True)
    try:
        if child.wait():
            raise ValueError("Environment preparation failed; inspect the command log")
    finally:
        stop_group(child)


def verify_recipe_hashes(spec, captured):
    identities = {item["path"]: item["sha256"] for item in captured["locks"]}
    for runtime, field, description in [("python", "wheels", "Wheel"), ("r", "packages", "R archive")]:
        recipe = spec["environment"].get(runtime)
        for package in recipe[field] if recipe else []:
            if identities[package["path"]] != package["sha256"]:
                raise ValueError(description + " does not match its expected checksum: " + package["path"])


def setup_receipt(receipt, kind, directory):
    setup = {"kind": kind, "directory": directory, "status": "creating"}
    receipt.setdefault("environmentSetups", []).append(setup)
    # The first recipe remains readable by viewers accepting a single environment.
    receipt.setdefault("environmentSetup", setup)
    return setup


# Library paths are deliberately absent from probe output so a fresh directory can reproduce it.
R_INVENTORY = """
lib <- Sys.getenv("R_LIBS_USER")
local <- utils::installed.packages(lib.loc=lib, noCache=TRUE)
if (!nrow(local)) stop("No reconstructed R packages found")
runtime <- utils::installed.packages(lib.loc=.Library, noCache=TRUE)
base <- runtime[!is.na(runtime[,"Priority"]) & runtime[,"Priority"] %in% c("base","recommended"),,drop=FALSE]
all <- rbind(local, runtime[!runtime[,"Package"] %in% local[,"Package"],,drop=FALSE])
deps <- unique(unlist(tools::package_dependencies(local[,"Package"], db=all,
    which=c("Depends","Imports","LinkingTo"), recursive=TRUE), use.names=FALSE))
missing <- setdiff(deps, c(local[,"Package"], base[,"Package"], "R"))
if (length(missing)) stop(paste("Undeclared R package dependencies:", paste(sort(missing), collapse=", ")))
cat(R.version.string, "\\n", R.version$platform, "\\n", sep="")
inventory <- rbind(cbind(local[,c("Package","Version"),drop=FALSE], Origin="reconstructed"),
    cbind(base[,c("Package","Version"),drop=FALSE], Origin="runtime"))
utils::write.table(inventory[order(inventory[,"Origin"],inventory[,"Package"]),,drop=FALSE],
    stdout(), sep="\\t", row.names=FALSE, col.names=TRUE, quote=TRUE)
""".strip()


def prepare_r(spec, root, receipt, filename, execution_env=None):
    recipe = spec["environment"].get("r")
    if not recipe:
        return execution_env
    directory = checked_path(root, recipe["directory"])
    if filename.is_relative_to(directory.parent):
        raise ValueError("The manifest must be outside the disposable environment")
    parent, name = parent_descriptor(root, str(directory.parent.relative_to(root)))
    try:
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
        except FileExistsError:
            pass
        os.fsync(parent)
    finally:
        os.close(parent)
    parent, name = parent_descriptor(root, recipe["directory"])
    try:
        os.mkdir(name, 0o700, dir_fd=parent)
        os.fsync(parent)
    finally:
        os.close(parent)
    environment = {
        key: value for key, value in (execution_env if execution_env is not None else os.environ).items()
        if not key.startswith("R_")
    }
    environment.update({
        "R_LIBS": str(directory), "R_LIBS_USER": str(directory), "R_LIBS_SITE": str(directory),
        "R_ENVIRON": os.devnull, "R_ENVIRON_USER": os.devnull,
        "R_PROFILE": os.devnull, "R_PROFILE_USER": os.devnull,
        "R_MAKEVARS_USER": os.devnull, "R_MAKEVARS_SITE": os.devnull,
    })
    setup = setup_receipt(receipt, "r_archives", recipe["directory"])
    atomic_write(filename, receipt)
    print("garden-run: installing recorded local R packages in declared order", file=sys.stderr, flush=True)
    setup["status"] = "installing"
    atomic_write(filename, receipt)
    for package in recipe["packages"]:
        # Check immediately before each installer as well as after the complete preparation.
        archive = checked_path(root, package["path"])
        if file_identity(root, package["path"])["sha256"] != package["sha256"]:
            raise ValueError("R archive changed before installation: " + package["path"])
        setup_command([recipe["interpreter"], "CMD", "INSTALL", "--no-multiarch",
            "--library=" + str(directory), str(archive)], root, environment)
    setup_command([recipe["interpreter"], "--vanilla", "--slave", "-e", R_INVENTORY], root, environment)
    setup["status"] = "ready"
    atomic_write(filename, receipt)
    return environment


def prepare_python(spec, root, receipt, filename):
    recipe = spec["environment"].get("python")
    if not recipe:
        return None
    directory = checked_path(root, recipe["directory"])
    if filename.is_relative_to(directory):
        raise ValueError("The manifest must be outside the disposable environment")
    # mkdir is exclusive; an existing or interrupted environment is never repaired in place.
    parent, name = parent_descriptor(root, recipe["directory"])
    try:
        os.mkdir(name, mode=0o700, dir_fd=parent)
    finally:
        os.close(parent)
    environment = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(("PIP_", "PYTHON")) and key != "VIRTUAL_ENV"
    }
    environment.update({"PIP_CONFIG_FILE": os.devnull, "PYTHONNOUSERSITE": "1"})
    setup = setup_receipt(receipt, "python_wheels", recipe["directory"])
    atomic_write(filename, receipt)
    print("garden-run: creating isolated Python environment", file=sys.stderr, flush=True)
    setup_command([recipe["interpreter"], "-I", "-m", "venv", str(directory)], root, environment)
    environment.update(
        {
            "VIRTUAL_ENV": str(directory),
            "PATH": str(directory / "bin") + os.pathsep + environment.get("PATH", os.defpath),
        }
    )
    python = str(directory / "bin/python")
    requirements = directory / "garden-wheels.txt"
    # Generated local wheel URIs prevent a requirements file from introducing URLs or flags.
    with requirements.open("x") as handle:
        for wheel in recipe["wheels"]:
            handle.write(
                checked_path(root, wheel["path"]).as_uri()
                + " --hash=sha256:" + wheel["sha256"] + "\n"
            )
    setup["status"] = "installing"
    atomic_write(filename, receipt)
    print("garden-run: installing the recorded local wheels", file=sys.stderr, flush=True)
    pip = [python, "-I", "-m", "pip", "--isolated", "--disable-pip-version-check", "--no-input"]
    setup_command(
        pip + [
            "install", "--no-index", "--no-deps", "--no-cache-dir",
            "--only-binary=:all:", "--require-hashes", "--force-reinstall",
            "-r", str(requirements),
        ], root, environment,
    )
    setup_command(pip + ["check"], root, environment)
    setup["status"] = "ready"
    atomic_write(filename, receipt)
    return environment


def run(spec, root, filename, previous=None):
    spec = validate(spec)
    filename = checked_path(root, relative(filename))
    reserved = (
        spec["sources"]
        + spec["outputs"]
        + spec["environment"]["lockFiles"]
        + [item["path"] for item in spec["inputs"]]
        + [item["producer"]["manifest"] for item in spec["inputs"] if "producer" in item]
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
        "directoryFromManifest": Path(os.path.relpath(root, filename.parent)).as_posix(),
        "spec": spec,
        "seedCoverage": "declared_by_caller_not_automatically_applied",
        "coverage": "declared_files_and_environment_probes",
        "note": (
            "Only declared local Python wheel or R archive recipes rebuild dependencies. No source download. "
            "Undeclared dependencies, external services and unsaved runtime state are not captured."
        ),
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
        files_before = capture_files(spec, root, hash_cache)
        if previous and any(
            previous["before"].get(key) != value for key, value in files_before.items()
        ):
            raise ValueError("Inputs, source or environment locks changed; execution refused")
        verify_recipe_hashes(spec, files_before)
        execution_env = prepare_python(spec, root, receipt, filename)
        execution_env = prepare_r(spec, root, receipt, filename, execution_env)
        before = capture(spec, root, hash_cache, execution_env)
        if any(before[key] != value for key, value in files_before.items()):
            raise ValueError("Declared files changed during environment preparation")
        receipt["before"] = before
        if previous and previous.get("before") != before:
            raise ValueError(
                "Inputs, source, environment locks, version probes or platform changed; execution refused"
            )
        receipt["status"] = "running"
        receipt["startedAt"] = now()
        atomic_write(filename, receipt)
        print("garden-run: running analysis", file=sys.stderr, flush=True)
        child = subprocess.Popen(spec["command"], cwd=root, start_new_session=True, env=execution_env)
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
        after = capture(spec, root, hash_cache, execution_env)
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
