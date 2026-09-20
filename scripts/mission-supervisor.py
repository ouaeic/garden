#!/usr/bin/python3
"""Root-owned supervisor for one confined command's PID namespace."""
import ctypes
import json
import os
import signal
import subprocess
import sys
import stat
import time


if sys.argv[1] == "--features":
    print("retained-process-trees=yes")
    print("project-input-locks=yes")
    sys.exit(0)


def read_record(fd):
    os.lseek(fd, 0, os.SEEK_SET)
    return json.loads(os.read(fd, 8192))


def write_record(fd, record):
    data = json.dumps(record, separators=(",", ":")).encode()
    os.lseek(fd, 0, os.SEEK_SET)
    os.write(fd, data)
    os.ftruncate(fd, len(data))
    os.fsync(fd)


def identity(pid):
    with open("/proc/%s/stat" % pid) as stream:
        details = stream.read()
    with open("/proc/sys/kernel/random/boot_id") as stream:
        boot = stream.read().strip()
    return {"pid": int(details.split(" ", 1)[0]), "identity": boot + ":" + details[details.rfind(")") + 2:].split(" ")[19]}


def alive(expected):
    if not expected:
        return False
    if not isinstance(expected.get("pid"), int) or not 1 <= expected["pid"] <= 2147483647 or not isinstance(expected.get("identity"), str):
        raise RuntimeError("Invalid process identity")
    try:
        return identity(expected["pid"]) == expected
    except FileNotFoundError:
        return False


if sys.argv[1] == "--status":
    file, parent, asker = sys.argv[2:5]
    relative = os.path.relpath(file, parent)
    parts = relative.split(os.sep)
    if len(parts) != 3 or parts[:2] != [".athanor", "sandbox"] or not parts[2].endswith(".lease") or not all(c in "0123456789abcdef" for c in parts[2][:-6]) or not parts[2][:-6]:
        raise RuntimeError("Invalid mission lease path")
    at = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    for part in parts[:-1]:
        below = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=at)
        os.close(at)
        at = below
    fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=at)
    os.close(at)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != int(asker) or info.st_nlink != 1:
        raise RuntimeError("Invalid mission lease owner")
    record = read_record(fd)
    os.close(fd)
    namespace = None
    expected = record.get("namespaceInit")
    namespace_alive = alive(expected)
    if namespace_alive:
        try:
            with open("/proc/%s/stat" % expected["pid"]) as stream:
                counters = stream.read()
            inode = str(os.stat("/proc/%s/ns/pid" % expected["pid"]).st_ino)
            if alive(expected):
                namespace = {"id": inode, "stat": counters}
        except FileNotFoundError:
            namespace_alive = False
    print(json.dumps({"namespaceAlive": namespace_alive, "supervisorAlive": alive(record.get("supervisor")), "groupAlive": alive(record.get("group")), "namespace": namespace}))
    sys.exit(0)


if sys.argv[1] == "--init":
    fd, gate = int(sys.argv[2]), int(sys.argv[3])
    if os.getpid() != 1:
        raise RuntimeError("The mission process did not enter its PID namespace")
    record = read_record(fd)
    # Before replacing procfs, its self link identifies this namespace init on the host.
    record["namespaceInit"] = identity("self")
    record["phase"] = "running"
    write_record(fd, record)
    os.close(fd)
    if os.pread(gate, 16, 0) != b"go" or time.time() * 1000 >= record["launchExpiresAt"]:
        os.close(gate)
        sys.exit(125)
    os.close(gate)
    mount = "/usr/bin/mount" if os.path.exists("/usr/bin/mount") else "/bin/mount"
    subprocess.run([mount, "-t", "proc", "-o", "nosuid,nodev,noexec", "proc", "/proc"], check=True)
    if record.get("retainDescendants") is not True:
        os.execv(sys.argv[4], sys.argv[4:])

    # PID 1 survives launcher exit so detached descendants remain accounted for and stoppable.
    # Signals reach this namespace only; kill(-1) cannot address host or sibling-project work.
    def forward(number, _frame):
        try:
            os.kill(-1, number)
        except ProcessLookupError:
            pass

    for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(number, forward)
    primary = os.fork()
    if primary == 0:
        for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            signal.signal(number, signal.SIG_DFL)
        os.execv(sys.argv[4], sys.argv[4:])
    # The command inherited the selected directory grants; init needs no held input descriptors.
    for name in os.listdir("/proc/self/fd"):
        if name.isdigit() and int(name) > 2:
            try:
                os.close(int(name))
            except OSError:
                pass
    primary_result = None
    descendant_result = 0
    while True:
        try:
            pid, status = os.waitpid(-1, 0)
        except InterruptedError:
            continue
        except ChildProcessError:
            break
        code = os.waitstatus_to_exitcode(status)
        code = code if code >= 0 else 128 - code
        if pid == primary:
            primary_result = code
        elif code and not descendant_result:
            descendant_result = code
    # A failed launcher or an unhandled orphan failure must not produce a successful receipt.
    sys.exit(125 if primary_result is None else (primary_result or descendant_result))

fd, gate, unshare = int(sys.argv[1]), int(sys.argv[2]), sys.argv[4]
descriptors = json.loads(sys.argv[3])
if not isinstance(descriptors, dict) or set(descriptors) != {"inputs", "locks"}:
    raise RuntimeError("Invalid mission descriptor groups")
inputs, locks = descriptors["inputs"], descriptors["locks"]
if not isinstance(inputs, list) or len(inputs) > 4160 or any(type(item) is not int or item < 3 or item in (fd, gate) for item in inputs):
    raise RuntimeError("Invalid mission input descriptors")
if len(set(inputs)) != len(inputs) or any(not stat.S_ISDIR(os.fstat(item).st_mode) for item in inputs):
    raise RuntimeError("Mission inputs must be distinct held directories")
if not isinstance(locks, list) or len(locks) > 64 or any(type(item) is not int or item < 3 or item in (fd, gate, *inputs) for item in locks):
    raise RuntimeError("Invalid project input lock descriptors")
if len(set(locks)) != len(locks) or any(not stat.S_ISDIR(os.fstat(item).st_mode) for item in locks):
    raise RuntimeError("Project input locks must be distinct held directories")
record = read_record(fd)
record["supervisor"] = identity(os.getpid())
record["group"] = identity(os.getpgrp())
record["phase"] = "supervising"
write_record(fd, record)
libc = ctypes.CDLL(None, use_errno=True)
PR_SET_PDEATHSIG, PR_SET_CHILD_SUBREAPER = 1, 36
parent = os.getppid()
child = None
stopping = False


def signal_child(number, _frame):
    global stopping
    if number != signal.SIGINT:
        stopping = True
    if child is not None and child.poll() is None:
        try:
            os.killpg(child.pid, signal.SIGINT if number == signal.SIGINT else signal.SIGKILL)
        except ProcessLookupError:
            pass


for number in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
    signal.signal(number, signal_child)
if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) or libc.prctl(PR_SET_PDEATHSIG, signal.SIGTERM, 0, 0, 0):
    raise OSError(ctypes.get_errno(), "Cannot enforce mission parent-death lifetime")
if parent <= 1 or os.getppid() != parent:
    sys.exit(125)
supervisor = os.getpid()


def parent_death():
    if libc.prctl(PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0):
        os._exit(125)
    if os.getppid() != supervisor:
        os._exit(125)


while not stopping and os.pread(gate, 16, 0) == b"" and time.time() * 1000 < record["launchExpiresAt"]:
    time.sleep(0.01)
if not stopping and os.pread(gate, 16, 0) == b"go" and time.time() * 1000 < record["launchExpiresAt"]:
    child = subprocess.Popen(
        [unshare, "--mount", "--pid", "--fork", "--kill-child", "--", "/usr/bin/python3", "-I", "-S", __file__, "--init", str(fd), str(gate)] + sys.argv[5:],
        start_new_session=True,
        # Landlock rules resolve these held directories after namespace creation.
        pass_fds=(fd, gate, *inputs),
        preexec_fn=parent_death,
    )
    if stopping:
        signal_child(signal.SIGTERM, None)
    result = child.wait()
    # The subreaper also waits for namespace init if unshare was killed first.
    while True:
        try:
            os.waitpid(-1, 0)
        except ChildProcessError:
            break
else:
    result = 125
record = read_record(fd)
record["phase"] = "reaped"
write_record(fd, record)
os.close(fd)
os.close(gate)
sys.exit(result if result >= 0 else 128 - result)
