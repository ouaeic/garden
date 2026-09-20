#!/usr/bin/env python3
"""Exercise the supervisor's real subprocess descriptor handoff without root."""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

if sys.platform != "linux":
    print("skip  mission descriptor handoff requires Linux process identities")
    sys.exit(0)

supervisor = Path(__file__).with_name("mission-supervisor.py")
with tempfile.TemporaryDirectory(prefix="garden-mission-inputs-") as temporary:
    root = Path(temporary)
    inputs = []
    for name in ("source", "version"):
        directory = root / name
        directory.mkdir()
        inputs.append(os.open(directory, os.O_RDONLY | os.O_DIRECTORY))
    lease = os.open(root / "lease", os.O_RDWR | os.O_CREAT, 0o600)
    gate = os.open(root / "gate", os.O_RDWR | os.O_CREAT, 0o600)
    stray = fcntl.fcntl(lease, fcntl.F_DUPFD, 256)
    try:
        os.write(lease, json.dumps({"launchExpiresAt": time.time() * 1000 + 30000}).encode())
        os.write(gate, b"go")
        expected = {str(item): [os.fstat(item).st_dev, os.fstat(item).st_ino] for item in inputs}
        # Substitute only namespace creation. The production supervisor launches this child
        # through its real Popen boundary, which must preserve the exact held directory inodes.
        child = root / "unshare"
        child.write_text("#!" + sys.executable + "\n" + f"""
import json, os
expected = {expected!r}
assert expected
for item, identity in expected.items():
    info = os.fstat(int(item))
    assert [info.st_dev, info.st_ino] == identity
try:
    os.fstat({stray})
except OSError:
    pass
else:
    raise AssertionError('An unrelated inherited descriptor reached the command')
with open({str(root / 'observed')!r}, 'w') as stream:
    json.dump(expected, stream)
""")
        child.chmod(0o700)
        subprocess.run(
            [sys.executable, str(supervisor), str(lease), str(gate), json.dumps({"inputs": inputs, "locks": []}), str(child), "/bin/true"],
            pass_fds=(lease, gate, *inputs, stray),
            check=True,
            timeout=15,
        )
        assert json.loads((root / "observed").read_text()) == expected
        os.lseek(lease, 0, os.SEEK_SET)
        assert json.loads(os.read(lease, 8192))["phase"] == "reaped"
    finally:
        for item in (*inputs, lease, gate, stray):
            os.close(item)
print("ok  supervised commands retain only the selected project input descriptors")
