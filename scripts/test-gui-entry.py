#!/usr/bin/python3
"""The GUI entry boundary accepts only live descriptors held by its launching runner."""
import contextlib
import importlib.machinery
import importlib.util
import json
import os
import pathlib
import tempfile
import subprocess
import sys
from unittest.mock import patch
import unittest


def load(name):
    loader = importlib.machinery.SourceFileLoader(name, str(pathlib.Path(__file__).with_name(name)))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


entry = load('athanor-gui')
broker = load('athanor-gui-broker')


class NamespaceHandles(unittest.TestCase):
    def handles(self):
        return {**{key: f'/proc/120/fd/{index + 3}' for index, key in enumerate(entry.NAMESPACE_KEYS)}, 'pid': 456, 'startTime': '12345'}

    def test_translates_only_explicit_namespace_handles(self):
        args = entry.namespace_handles(json.dumps(self.handles()), 120)
        self.assertEqual(set(args), {*entry.NAMESPACE_KEYS, 'pid', 'startTime'})
        self.assertEqual(args['process'], '/proc/120/fd/3')

    def test_refuses_foreign_processes_and_path_syntax(self):
        candidates = ['/proc/121/fd/3', '/proc/120/fd/2', '/proc/120/fd/3/../../../root',
                      '/proc/120/ns/user', '--user=/proc/120/fd/3', '/proc/120/fd/3\n']
        self.assertTrue(candidates)
        for candidate in candidates:
            with self.subTest(candidate=candidate), self.assertRaises(ValueError):
                entry.namespace_handles(json.dumps({**self.handles(), 'process': candidate}), 120)

    def test_refuses_missing_extra_duplicate_and_non_string_handles(self):
        value = self.handles()
        cases = [[], {**value, 'extra': 'secret'}, {**value, 'root': value['process']}, {**value, 'root': 8}, {**value, 'pid': True}, {**value, 'pid': 0}, {**value, 'startTime': 'bad'}, {**value, 'startTime': 1}]
        del value['process']
        cases.append(value)
        self.assertTrue(cases)
        for case in cases:
            with self.subTest(case=case), self.assertRaises(ValueError):
                entry.namespace_handles(json.dumps(case), 120)


class BrokerBoundary(unittest.TestCase):
    def test_only_execution_roots_and_transient_research_roots_are_accepted(self):
        root = '/home/athanor/11111111-2222-4333-8444-555555555555'
        self.assertEqual(str(broker.workspace_root(root)), root)
        self.assertEqual(str(broker.workspace_root(root + '/.athanor/gui/research/session-abc123')),
                         root + '/.athanor/gui/research/session-abc123')
        rejected = ['/', '/home/athanor', '/etc/athanor', root + '/workspace',
                    root + '/../other', root + '/.athanor/gui/research/session-../x', root + '\n', None, 1]
        self.assertTrue(rejected)
        for candidate in rejected:
            with self.subTest(candidate=candidate), self.assertRaises(ValueError):
                broker.workspace_root(candidate)

    def test_mount_sources_are_held_and_machine_identity_is_private_and_bounded(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary).resolve()
            with contextlib.ExitStack() as stack:
                args, fds = broker.namespace_command(root, stack)
                self.assertEqual(len(fds), 2)
                self.assertEqual(os.fstat(fds[0]).st_ino, root.stat().st_ino)
                self.assertIn(f'/proc/self/fd/{fds[0]}', args)
                self.assertIn('--unshare-pid', args)
                self.assertIn('--unshare-ipc', args)
                self.assertEqual(args[-1], 'printf READY; exec /usr/bin/sleep infinity')
                for forbidden in ['/', '/home/athanor', '/etc/athanor', '/etc/ssl/private']:
                    self.assertNotIn(forbidden, args)
            identity = root / '.athanor/gui/machine-id'
            first = identity.read_text()
            self.assertRegex(first, r'^[a-f0-9]{32}\n$')
            with contextlib.ExitStack() as stack:
                broker.namespace_command(root, stack)
            self.assertEqual(identity.read_text(), first)
            identity.write_text('a' * 4096)
            with contextlib.ExitStack() as stack, self.assertRaises(ValueError):
                broker.namespace_command(root, stack)
            identity.unlink()
            identity.symlink_to('/etc/passwd')
            with contextlib.ExitStack() as stack, self.assertRaises(OSError):
                broker.namespace_command(root, stack)

    def test_metadata_pipe_may_close_before_the_readiness_pipe_produces_output(self):
        program = ("import os,json,time; os.write(2,json.dumps({'child-pid':os.getpid()}).encode()); "
                   "os.close(2); time.sleep(.05); os.write(1,b'READY'); time.sleep(5)")
        child = subprocess.Popen([sys.executable, '-c', program], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            with patch.object(broker.pathlib.Path, 'read_text', return_value='123 (keeper) ' + ' '.join(['S'] + ['0'] * 18 + ['23'])):
                self.assertEqual(broker.ready(child), {'protocol': 1, 'pid': child.pid, 'startTime': '23'})
        finally:
            broker.stop(child)

    def test_workspace_symlinks_and_shared_gui_state_are_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary).resolve()
            actual = root / 'actual'; actual.mkdir()
            alias = root / 'alias'; alias.symlink_to(actual, target_is_directory=True)
            with contextlib.ExitStack() as stack, self.assertRaises(OSError):
                broker.namespace_command(alias, stack)
            gui = actual / '.athanor/gui'; gui.mkdir(parents=True); gui.chmod(0o770)
            with contextlib.ExitStack() as stack, self.assertRaises(ValueError):
                broker.namespace_command(actual, stack)


if __name__ == '__main__':
    unittest.main()
