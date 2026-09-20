"""Native R protocol drill. Requires Rscript and jsonlite; optional library directories are arguments."""
import base64
import json
import os
from pathlib import Path
import re
import select
import signal
import subprocess
import sys
import tempfile
import time
import uuid

source = Path(__file__).resolve().parents[1] / 'services/workspace-runner/src/computation-r.ts'
matches = re.findall(r'export const R_COMPUTATION = String\.raw`([\s\S]*?)`;', source.read_text())
assert len(matches) == 1, 'Native R program must be present exactly once'
program = matches[0]


class Kernel:
    def __init__(self, directory):
        self.token = 'garden:' + uuid.uuid4().hex + ':'
        self.buffer = b''
        self.output = b''
        bootstrap = Path(directory) / ('bootstrap-' + uuid.uuid4().hex + '.R')
        bootstrap.write_text(program)
        self.process = subprocess.Popen(
            ['Rscript', '--vanilla', str(bootstrap), self.token, *sys.argv[1:]],
            cwd=directory, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, start_new_session=True)
        try:
            packet = self.packet()
            assert packet['kind'] == 'ready', packet
            assert packet['runtime']['version'] and packet['runtime']['architecture']
        except BaseException:
            self.close()
            raise

    def packet(self):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if b'\n' in self.buffer:
                line, self.buffer = self.buffer.split(b'\n', 1)
                marker = line.find(self.token.encode())
                if marker < 0:
                    self.output += line + b'\n'
                    continue
                self.output += line[:marker]
                return json.loads(line[marker + len(self.token):])
            readable, _, _ = select.select([self.process.stdout, self.process.stderr], [], [], 1)
            for stream in readable:
                chunk = os.read(stream.fileno(), 65536)
                if stream is self.process.stderr:
                    if chunk:
                        raise AssertionError('Unexpected native stderr: ' + chunk.decode(errors='replace'))
                elif chunk:
                    self.buffer += chunk
                else:
                    raise AssertionError('R exited without a complete packet')
        raise AssertionError('R protocol timed out: '+repr((self.output+self.buffer)[-1000:]))

    def send(self, **request):
        request.setdefault('cellId', uuid.uuid4().hex)
        self.process.stdin.write((json.dumps(request) + '\n').encode())
        self.process.stdin.flush()
        return request['cellId']

    def result(self):
        messages = []
        while True:
            packet = self.packet()
            if packet['kind'] == 'output':
                messages.append(packet)
                continue
            assert packet['kind'] == 'done', packet
            packet['messages'] = messages
            return packet

    def cell(self, code):
        self.send(action='cell', code=code)
        return self.result()

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait()


with tempfile.TemporaryDirectory(prefix='garden-r-native-') as directory:
    kernels = []
    checks = []
    try:
        first = Kernel(directory)
        kernels.append(first)
        assert first.cell('values <- c(2, 3, 5)')['error'] is None
        assert first.cell('sum(values)')['result']['value'] == 10
        checks.append('retained values and scalar output')
        result = first.cell('delayedAssign("lazy", {writeLines("forced", "forced.txt"); 99}); makeActiveBinding("active",function()stop("must not inspect"),environment()); 1')
        assert result['error'] is None and result['result']['value'] == 1
        assert any(v['name'] == 'active' and v['type'] == 'active binding' for v in result['variables'])
        assert not (Path(directory) / 'forced.txt').exists()
        checks.append('inspection does not force delayed or active bindings')
        result = first.cell('warning("warning proof"); message("message proof"); cat("αβ"); 42')
        assert result['error'] is None and result['result']['value'] == 42
        assert any('warning proof' in v['text'] for v in result['messages'])
        assert any('message proof' in v['text'] for v in result['messages'])
        assert 'αβ' in first.output.decode()
        checks.append('Unicode output, warnings and messages')
        assert first.cell('table <- data.frame(group=factor(c("A","B")), n=c(NA_integer_,3L)); mat <- matrix(1:6,2,3); special <- c(NA_real_,NaN,Inf,-Inf,1/3); raw.data <- as.raw(c(0,255)); z <- c(1+2i,NA_complex_); empty <- list()')['error'] is None
        selected = ['table', 'mat', 'special', 'raw.data', 'z', 'empty']
        first.send(action='checkpoint', variables=selected)
        checkpoint = first.result()
        assert checkpoint['error'] is None, checkpoint
        second = Kernel(directory)
        kernels.append(second)
        second.send(action='restore', values=checkpoint['result']['checkpoint'])
        restored = second.result()
        assert restored['error'] is None, restored
        comparison = 'identical(table,data.frame(group=factor(c("A","B")),n=c(NA_integer_,3L))) && identical(mat,matrix(1:6,2,3)) && identical(special,c(NA_real_,NaN,Inf,-Inf,1/3)) && identical(raw.data,as.raw(c(0,255))) && identical(z,c(1+2i,NA_complex_)) && identical(empty,list())'
        compared = second.cell(comparison)
        assert compared['result']['value'] is True, compared
        checks.append('typed JSON restores data frames, factors, matrices, missing values, raw and complex vectors')
        second.cell('sentinel <- 7')
        for malformed in ['1.5', '2147483648', 'not-a-number']:
            second.send(action='restore', values={
                'sentinel': {'type': 'integer', 'data': ['99'], 'attributes': None},
                'invalid': {'type': 'integer', 'data': [malformed], 'attributes': None}})
            assert second.result()['error'] is not None
            assert second.cell('sentinel')['result']['value'] == 7
        checks.append('malformed restore is refused before changing any selected variable')
        first.send(action='checkpoint', variables=['active'])
        assert first.result()['error'] is not None
        first.cell('fn <- function() 1')
        first.send(action='checkpoint', variables=['fn'])
        assert first.result()['error'] is not None
        assert first.cell('sum(values)')['result']['value'] == 10
        checks.append('non-data and active checkpoints fail without losing session state')
        result = first.cell('plot(1:3); plot(3:1)')
        assert result['error'] is None, result
        assert len(result['artifacts']) == 2, result
        assert all(base64.b64decode(v['base64']).startswith(b'\x89PNG\r\n\x1a\n') for v in result['artifacts'])
        checks.append('multiple default plots produce independent PNGs')
        first.send(action='cell', code='answer <- 42; repeat {}')
        time.sleep(0.15)
        os.killpg(first.process.pid, signal.SIGINT)
        result = first.result()
        assert result['error']['interrupted'] is True, result
        assert first.cell('answer')['result']['value'] == 42
        checks.append('acknowledged interruption retains prior values')
        assert first.cell('stop("expected failure")')['error']['message'] == 'expected failure'
        assert first.cell('sum(values)')['result']['value'] == 10
        checks.append('cell errors retain session continuity')
        third = Kernel(directory)
        kernels.append(third)
        assert third.cell('sentinel <- 7; lockEnvironment(environment(),bindings=FALSE)')['error'] is None
        third.send(action='restore', values={
            'sentinel': {'type': 'integer', 'data': ['99'], 'attributes': None},
            'newbinding': {'type': 'integer', 'data': ['42'], 'attributes': None}})
        assert third.result()['error'] is not None
        assert third.cell('sentinel')['result']['value'] == 7
        checks.append('locked environments refuse new bindings without partial restore')
        print(json.dumps({'passed': True, 'checks': checks}))
    finally:
        for kernel in kernels:
            kernel.close()
