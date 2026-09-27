#!/usr/bin/env python3
"""Check image extraction everywhere and real userland/service reconstruction on Linux."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
definition = importlib.util.spec_from_file_location("garden_run", ROOT / "reproducible-run.py")
runner = importlib.util.module_from_spec(definition)
definition.loader.exec_module(runner)
system = runner.system_module()
BWRAP = os.environ.get("GARDEN_SYSTEM_LAUNCHER") or shutil.which("bwrap")
CC = shutil.which("cc")


class Extraction(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="garden-system-")
        self.root = Path(self.temporary.name)
        self.destination = self.root / "out"
        self.destination.mkdir()

    def tearDown(self):
        self.temporary.cleanup()

    def archive(self, members):
        archive = self.root / "image.tar"
        with tarfile.open(archive, "w") as stream:
            for name, content, kind in members:
                info = tarfile.TarInfo(name)
                if kind == "file":
                    info.size = len(content)
                    info.mode = 0o4755
                    stream.addfile(info, io.BytesIO(content))
                else:
                    info.type = tarfile.SYMTYPE if kind == "link" else tarfile.CHRTYPE
                    info.linkname = content
                    stream.addfile(info)
        return {"path": "image.tar", "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}

    def test_regular_image_and_absolute_guest_link(self):
        lock = self.archive([("usr/bin/tool", b"tool", "file"), ("bin", "/usr/bin", "link")])
        system.unpack(self.root, lock, self.destination, runner.system_api())
        self.assertEqual((self.destination / "bin/tool").read_bytes(), b"tool")
        self.assertFalse((self.destination / "usr/bin/tool").stat().st_mode & 0o6000)
        self.assertEqual(os.readlink(self.destination / "bin"), "usr/bin")

    def test_archive_paths_devices_links_and_duplicates_are_refused(self):
        cases = [
            [("../escaped", b"x", "file")],
            [("/escaped", b"x", "file")],
            [("link", "../escaped", "link")],
            [("device", "", "device")],
            [("same", b"x", "file"), ("same", b"y", "file")],
            [("link", "/outside", "link"), ("link/file", b"x", "file")],
        ]
        for index, members in enumerate(cases):
            with self.subTest(index=index):
                destination = self.root / str(index)
                destination.mkdir()
                with self.assertRaises((ValueError, FileExistsError)):
                    system.unpack(self.root, self.archive(members), destination, runner.system_api())
        self.assertFalse((self.root / "escaped").exists())

    def test_changed_archive_is_refused_before_execution(self):
        lock = self.archive([("file", b"good", "file")])
        self.archive([("file", b"evil", "file")])
        with self.assertRaisesRegex(ValueError, "archive changed"):
            system.unpack(self.root, lock, self.destination, runner.system_api())


SOURCE = r'''
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
static int connect_service(void) {
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  struct sockaddr_un addr = {.sun_family=AF_UNIX};
  strcpy(addr.sun_path, "/state/service.sock");
  if (connect(fd, (struct sockaddr*)&addr, sizeof(addr))) return -1;
  return fd;
}
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  if (!strcmp(argv[1], "version")) { puts("fixture-runtime-v1"); return 0; }
  if (!strcmp(argv[1], "serve")) {
    int fd=socket(AF_UNIX, SOCK_STREAM, 0);
    struct sockaddr_un addr={.sun_family=AF_UNIX};
    strcpy(addr.sun_path,"/state/service.sock");
    if(bind(fd,(struct sockaddr*)&addr,sizeof(addr)) || listen(fd,8)) return 3;
    for(;;) {
      int peer=accept(fd,NULL,NULL); char input[32]={0};
      if(peer<0) return 4;
      int n=read(peer,input,sizeof(input)-1);
      if(n>0 && !strcmp(input,"value")) {
        FILE *source=fopen("/state/seed.txt","r"); int number;
        if(!source || fscanf(source,"%d",&number)!=1) return 5;
        fclose(source); char output[32]; int size=snprintf(output,sizeof(output),"%d\n",number*7);
        if(write(peer,output,size)!=size) return 6;
      }
      close(peer);
    }
  }
  int fd=connect_service(); if(fd<0) return 7;
  if(!strcmp(argv[1],"ready")) { close(fd); return 0; }
  if(strcmp(argv[1],"run")) return 8;
  if(getenv("GARDEN_SECRET_CANARY") || access("/etc/hostname", F_OK)==0) return 9;
  if(write(fd,"value",5)!=5) return 10;
  char output[32]={0}; int n=read(fd,output,sizeof(output));
  if(n<=0) return 11;
  FILE *result=fopen("result.txt","w"); if(!result) return 12;
  fwrite(output,1,n,result); fclose(result); close(fd); return 0;
}
'''


@unittest.skipUnless(platform.system() == "Linux" and BWRAP and CC, "native Linux bwrap/compiler acceptance")
class NativeUserland(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="garden-userland-")
        self.root = Path(self.temporary.name)
        self.first = self.root / "first"
        self.first.mkdir()
        image = self.root / "image"
        (image / "bin").mkdir(parents=True)
        (self.first / "program.c").write_text(SOURCE)
        binary = image / "bin/proof"
        subprocess.run([CC, str(self.first / "program.c"), "-o", str(binary)], check=True)
        dependencies = subprocess.check_output(["ldd", str(binary)], text=True)
        libraries = re.findall(r"(?:=>\s*)?(/[^\s()]+)", dependencies)
        self.assertTrue(libraries)
        for source in libraries:
            target = image / source.lstrip('/')
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            target.chmod(0o755)
        with tarfile.open(self.first / "image.tar", "w") as archive:
            archive.add(image, arcname=".", recursive=True)
        with tarfile.open(self.first / "data.tar", "w") as archive:
            info = tarfile.TarInfo("seed.txt")
            info.size = 3
            archive.addfile(info, io.BytesIO(b"11\n"))
        def lock(name):
            return {"path": name, "sha256": hashlib.sha256((self.first / name).read_bytes()).hexdigest()}
        self.spec = {
            "name": "Restore a service and compute a result", "command": ["/bin/proof", "run"],
            "sources": ["program.c"], "inputs": [], "outputs": ["result.txt"],
            "environment": {"lockFiles": ["image.tar", "data.tar"],
                "system": {"directory": ".garden/system", "image": lock("image.tar"),
                    "data": lock("data.tar"), "launcher": {"path": BWRAP,
                        "sha256": hashlib.sha256(Path(BWRAP).read_bytes()).hexdigest()},
                    "services": [{"name": "lookup", "command": ["/bin/proof", "serve"],
                                  "ready": ["/bin/proof", "ready"], "readySeconds": 172800}]},
                "probes": [{"name": "Guest runtime", "command": ["/bin/proof", "version"]}]}
        }
        self.save()

    def tearDown(self):
        self.temporary.cleanup()

    def save(self):
        (self.first / "spec.json").write_text(json.dumps(self.spec))

    def invoke(self, root=None, replay=None):
        command = [sys.executable, str(ROOT / "reproducible-run.py")]
        command += ["replay", "--from-manifest", str(replay)] if replay else ["run", "--spec", "spec.json"]
        return subprocess.run(command + ["--manifest", "run.json"], cwd=root or self.first,
            env={**os.environ, "GARDEN_SECRET_CANARY": "must-not-inherit"}, capture_output=True, text=True, timeout=30)

    def test_recreates_userland_service_and_data_then_replays_identical_output(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.first / "result.txt").read_text(), "77\n")
        receipt = json.loads((self.first / "run.json").read_text())
        self.assertEqual(receipt["environmentSetups"][0]["kind"], "linux_userland")
        self.assertEqual(receipt["services"][0]["status"], "stopped")
        with self.assertRaises(ProcessLookupError):
            os.kill(receipt["services"][0]["pid"], 0)
        second = self.root / "second"
        second.mkdir()
        for name in ["program.c", "image.tar", "data.tar"]:
            shutil.copy2(self.first / name, second / name)
        replay = self.invoke(second, self.first / "run.json")
        self.assertEqual(replay.returncode, 0, replay.stderr)
        self.assertTrue(json.loads((second / "run.json").read_text())["outputsMatchPrevious"])

    def test_changed_lock_never_starts_a_service(self):
        with open(self.first / "data.tar", "ab") as file:
            file.write(b"changed")
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("lock changed", result.stderr)
        self.assertFalse((self.first / ".garden/system").exists())

    def test_failed_readiness_stops_service_and_preserves_evidence(self):
        self.spec["environment"]["system"]["services"][0]["ready"] = ["/absent"]
        self.spec["environment"]["system"]["services"][0]["readySeconds"] = 1
        self.save()
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        receipt = json.loads((self.first / "run.json").read_text())
        self.assertEqual(receipt["status"], "failed")
        self.assertEqual(receipt["services"][0]["status"], "stopped")
        self.assertFalse((self.first / "result.txt").exists())
        with self.assertRaises(ProcessLookupError):
            os.kill(receipt["services"][0]["pid"], 0)


if __name__ == "__main__":
    unittest.main()
