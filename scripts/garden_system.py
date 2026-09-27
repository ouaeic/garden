"""Recreate declared Linux userland and service data inside the caller's authority."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import signal
import stat
import subprocess
import tarfile
import time


def validate(recipe, environment, files, api):
    api.exact_keys(recipe, ["launcher", "image", "directory"], ["data", "services"])
    recipe["directory"] = api.relative(recipe["directory"])
    directory = Path(recipe["directory"])
    if tuple(directory.parts[-2:]) != (".garden", "system"):
        raise ValueError("Use a .garden/system directory for the disposable userland")
    if environment.get("runtimeOnly") or any(name in environment for name in ["python", "r", "conda"]):
        raise ValueError("A system image contains its own runtimes; declare its complete package set in the image")
    if any(Path(name).is_relative_to(directory) for name in files):
        raise ValueError("The disposable userland cannot contain declared run files")
    api.exact_keys(recipe["launcher"], ["path", "sha256"])
    if recipe["launcher"]["path"] not in ["/usr/bin/bwrap", "/usr/bin/proot"] or not re.fullmatch(r"[a-f0-9]{64}", str(recipe["launcher"]["sha256"])):
        raise ValueError("Pin the installed bwrap or proot launcher by SHA-256")
    for item in locks(recipe):
        api.exact_keys(item, ["path", "sha256"])
        item["path"] = api.relative(item["path"])
        if item["path"] not in environment["lockFiles"] or not re.fullmatch(r"[a-f0-9]{64}", str(item["sha256"])):
            raise ValueError("System image, launcher and data need declared lock files and SHA-256")
    services = recipe.get("services", [])
    if not isinstance(services, list) or len(services) > 32:
        raise ValueError("Invalid declared service list")
    names = set()
    for service in services:
        api.exact_keys(service, ["name", "command", "ready"], ["readySeconds"])
        if not isinstance(service["name"], str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,62}", service["name"]) or service["name"] in names:
            raise ValueError("Services need distinct simple names")
        names.add(service["name"])
        api.argv(service["command"])
        api.argv(service["ready"])
        seconds = service.get("readySeconds", 60)
        if type(seconds) is not int or not 1 <= seconds <= 9_007_199_254_740_991:
            raise ValueError("Service readiness must have a bounded startup deadline")


def locks(recipe):
    return [recipe["image"]] + ([recipe["data"]] if "data" in recipe else [])


def launcher_identity(recipe):
    with open(recipe["launcher"]["path"], "rb") as binary:
        digest = hashlib.file_digest(binary, "sha256").hexdigest()
    if digest != recipe["launcher"]["sha256"]:
        raise ValueError("The installed environment launcher changed")
    return digest


def unpack(root, item, destination, api):
    """No archive path, link or device can address the host outside the new tree."""
    destination = destination.resolve(strict=True)
    descriptor = api.open_relative(root, item["path"], os.O_RDONLY | os.O_NONBLOCK)
    pending = []
    seen = set()
    digest = hashlib.sha256()
    before = os.fstat(descriptor)
    if not stat.S_ISREG(before.st_mode):
        os.close(descriptor)
        raise ValueError("System archives must be regular files")

    class Reader:
        def read(self, count=-1):
            content = os.read(descriptor, count if count >= 0 else 1024 * 1024)
            digest.update(content)
            return content

    def name(value):
        path = PurePosixPath(value)
        if path.is_absolute() or ".." in path.parts or "\\" in value or "\0" in value:
            raise ValueError("An archive member leaves the reconstructed tree")
        return Path(*path.parts)

    destination_fd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)

    @contextmanager
    def parent_fd(relative):
        current = os.dup(destination_fd)
        try:
            for part in relative.parts[:-1]:
                try:
                    os.mkdir(part, 0o770, dir_fd=current)
                except FileExistsError:
                    pass
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
                os.close(current)
                current = child
            yield current
        finally:
            os.close(current)

    def create_file(relative, source, mode):
        with parent_fd(relative) as directory:
            fd = os.open(relative.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         mode, dir_fd=directory)
            with os.fdopen(fd, "wb") as output:
                shutil.copyfileobj(source, output, 1024 * 1024)
                os.fchmod(output.fileno(), mode)

    try:
        with tarfile.open(fileobj=Reader(), mode="r|*") as archive:
            for member in archive:
                relative = name(member.name)
                target = destination / relative
                if relative == Path('.'):
                    if not member.isdir():
                        raise ValueError("Invalid archive root")
                    continue
                if relative in seen:
                    raise ValueError("Duplicate archive member")
                seen.add(relative)
                if member.isdir():
                    with parent_fd(relative) as directory:
                        try:
                            os.mkdir(relative.name, 0o770, dir_fd=directory)
                        except FileExistsError:
                            existing = os.open(relative.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                            os.close(existing)
                elif member.isfile():
                    with archive.extractfile(member) as source:
                        create_file(relative, source, 0o770 if member.mode & 0o111 else 0o660)
                elif member.issym() or member.islnk():
                    pending.append((relative, member.linkname, member.issym()))
                else:
                    raise ValueError("System archives may contain only directories, regular files and confined links")
        while Reader().read(1024 * 1024):
            pass
        if digest.hexdigest() != item["sha256"] or api.stat_stamp(before) != api.stat_stamp(os.fstat(descriptor)):
            raise ValueError("System archive changed while restoring it")
        for relative, link, symbolic in pending:
            target = destination / relative
            if "\0" in link or "\\" in link:
                raise ValueError("Invalid archive link")
            if symbolic:
                resolved = Path(os.path.normpath(str(destination / link.lstrip('/') if link.startswith('/') else target.parent / link)))
                if not resolved.is_relative_to(destination):
                    raise ValueError("Archive link leaves the reconstructed tree")
                with parent_fd(relative) as directory:
                    os.symlink(os.path.relpath(resolved, target.parent), relative.name, dir_fd=directory)
            else:
                source_name = name(link)
                with parent_fd(source_name) as directory:
                    fd = os.open(source_name.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                with os.fdopen(fd, "rb") as source:
                    info = os.fstat(source.fileno())
                    if not stat.S_ISREG(info.st_mode):
                        raise ValueError("Archive hard link must name a regular file")
                    create_file(relative, source, info.st_mode & 0o770)
        # Individually confined targets can still escape when composed through another link.
        for relative, _, symbolic in pending:
            if symbolic and not (destination / relative).resolve().is_relative_to(destination):
                raise ValueError("Archive link chain leaves the reconstructed tree")
        if not seen:
            raise ValueError("The system archive is empty")
    finally:
        os.close(destination_fd)
        os.close(descriptor)


class SystemEnvironment:
    def __init__(self, spec, root, receipt, filename, api):
        self.root, self.receipt, self.filename, self.api = root, receipt, filename, api
        self.recipe = spec["environment"]["system"]
        self.directory = api.checked_path(root, self.recipe["directory"])
        self.services = []
        if platform.system() != "Linux":
            raise ValueError("Linux userland reconstruction requires a Linux host")
        launcher_identity(self.recipe)
        if filename.is_relative_to(self.directory):
            raise ValueError("The receipt must be outside the disposable userland")
        self.directory.parent.mkdir(exist_ok=True, mode=0o770)
        api.checked_path(root, self.recipe["directory"])
        self.directory.mkdir(mode=0o770)
        self.setup = api.setup_receipt(receipt, "linux_userland", self.recipe["directory"])
        api.atomic_write(filename, receipt)
        for name, item in [("rootfs", self.recipe["image"]), ("data", self.recipe.get("data"))]:
            destination = self.directory / name
            destination.mkdir(mode=0o770)
            if item:
                unpack(root, item, destination, api)
        for name in ["work", "state", "proc", "dev", "tmp"]:
            target = self.directory / "rootfs" / name
            if target.is_symlink() or (target.exists() and not target.is_dir()):
                raise ValueError("Image mount points must be real directories")
            target.mkdir(exist_ok=True, mode=0o770)
        self.launcher = self.recipe["launcher"]["path"]
        self.environment = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp", "LANG": "C", "LC_ALL": "C"}
        if self.launcher == "/usr/bin/proot":
            for name in ["temporary", "hidden"]:
                (self.directory / name).mkdir(mode=0o770)
            for name in ["null", "zero", "random", "urandom"]:
                target = self.directory / "rootfs/dev" / name
                if not target.exists():
                    fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o660)
                    os.close(fd)
                elif target.is_symlink() or not target.is_file():
                    raise ValueError("Image device mount points must be regular placeholders")
            self.environment["PROOT_TMP_DIR"] = str(self.directory / "temporary")
            self.environment["PROOT_NO_SECCOMP"] = "1"
        self.setup["status"] = "ready"
        api.atomic_write(filename, receipt)

    def image_identity(self):
        digest = hashlib.sha256()
        root = self.directory / "rootfs"
        for current, directories, files, descriptor in os.fwalk(root, follow_symlinks=False):
            directories.sort()
            relative = Path(current).relative_to(root)
            for name in sorted(directories + files):
                info = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                label = str(relative / name)
                if stat.S_ISLNK(info.st_mode):
                    value = [label, "link", os.readlink(name, dir_fd=descriptor)]
                elif stat.S_ISDIR(info.st_mode):
                    value = [label, "directory", stat.S_IMODE(info.st_mode)]
                elif stat.S_ISREG(info.st_mode):
                    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
                    with os.fdopen(fd, "rb") as file:
                        before = os.fstat(file.fileno())
                        content = hashlib.file_digest(file, "sha256").hexdigest()
                        if self.api.stat_stamp(before) != self.api.stat_stamp(os.fstat(file.fileno())):
                            raise ValueError("The reconstructed image changed while checking it")
                    value = [label, "file", stat.S_IMODE(info.st_mode), content]
                else:
                    raise ValueError("The reconstructed image contains an undeclared special file")
                digest.update(json.dumps(value, separators=(",", ":")).encode())
                digest.update(b"\n")
        return digest.hexdigest()

    def identity(self):
        value = json.dumps({"launcher": launcher_identity(self.recipe),
                            "image": self.recipe["image"]["sha256"], "restoredTree": self.image_identity(),
                            "data": self.recipe.get("data", {}).get("sha256")}, sort_keys=True)
        return {"name": "Garden rebuilt Linux environment", "command": [self.launcher],
                "output": value, "sha256": hashlib.sha256(value.encode()).hexdigest()}

    def command(self, command):
        # Network authority is inherited from the governed parent command. No host root, HOME,
        # credentials, daemon socket or arbitrary mount list is passed into the image.
        if self.launcher == "/usr/bin/proot":
            # PRoot supplies path translation only. The parent's sandbox remains the authority.
            args = [self.launcher, "--kill-on-exit", "-r", str(self.directory / "rootfs"),
                    "-b", str(self.root) + ":/work!",
                    "-b", str(self.directory / "hidden") + ":/work/" + self.recipe["directory"] + "!",
                    "-b", str(self.directory / "data") + ":/state!",
                    "-b", str(self.directory / "temporary") + ":/tmp!", "-w", "/work"]
            for device in ["null", "zero", "random", "urandom"]:
                args += ["-b", "/dev/" + device + ":/dev/" + device + "!"]
            return [*args, *command]
        return [self.launcher, "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
                "--die-with-parent", "--new-session", "--cap-drop", "ALL",
                "--ro-bind", str(self.directory / "rootfs"), "/",
                "--bind", str(self.root), "/work", "--tmpfs", "/work/" + self.recipe["directory"],
                "--bind", str(self.directory / "data"), "/state",
                "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
                "--clearenv", "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin",
                "--setenv", "HOME", "/tmp", "--setenv", "LANG", "C", "--setenv", "LC_ALL", "C",
                "--chdir", "/work", "--", *command]

    def start(self):
        for service in self.recipe.get("services", []):
            log = self.directory / (service["name"] + ".log")
            handle = open(log, "xb")
            child = subprocess.Popen(self.command(service["command"]), cwd=self.root,
                                     env=self.environment, stdout=handle, stderr=subprocess.STDOUT,
                                     start_new_session=True)
            row = {"name": service["name"], "pid": child.pid, "status": "starting",
                   "log": str(log.relative_to(self.root)), "startedAt": self.api.now()}
            self.services.append((child, handle, row))
            self.receipt.setdefault("services", []).append(row)
            self.api.atomic_write(self.filename, self.receipt)
            deadline = time.monotonic() + service.get("readySeconds", 60)
            while True:
                if child.poll() is not None:
                    raise ValueError("Service exited before readiness: " + service["name"])
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ValueError("Service readiness timed out: " + service["name"])
                probe = subprocess.Popen(self.command(service["ready"]), cwd=self.root,
                                         env=self.environment, stdout=subprocess.DEVNULL,
                                         stderr=subprocess.DEVNULL, start_new_session=True)
                try:
                    ready = probe.wait(timeout=min(5, remaining)) == 0
                except subprocess.TimeoutExpired:
                    ready = False
                finally:
                    self.api.stop_group(probe)
                if ready:
                    row["status"] = "ready"
                    self.api.atomic_write(self.filename, self.receipt)
                    break
                time.sleep(min(0.1, max(0, deadline - time.monotonic())))

    def check(self):
        for child, _, row in self.services:
            if child.poll() is not None:
                raise ValueError("Service stopped during the run: " + row["name"])

    def close(self):
        for child, handle, row in reversed(self.services):
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                    child.wait(timeout=5)
                except ProcessLookupError:
                    pass
                except subprocess.TimeoutExpired:
                    self.api.stop_group(child)
            handle.close()
            row["status"] = "stopped"
            row["finishedAt"] = self.api.now()
            row["exitCode"] = child.returncode
