# Local models and LAN connections

In Settings → Models → Add a provider, choose **Local models**. Garden connects through the
OpenAI-compatible API of an inference server you install and manage. Cloud connections remain
available alongside it; each selected model stays bound to its own connection.

For Ollama on the Garden server, use `http://127.0.0.1:11434/v1`. A standard Ollama installation
needs no API key. Install a model with tool calling support before connecting, then match Garden's
context-window field to the context size configured in Ollama. The form's suggested size does not
reconfigure Ollama. See [Ollama's compatibility documentation](https://docs.ollama.com/api/openai-compatibility)
for setting the context size. Model discovery lists the models that endpoint offers.

For Ollama on another computer, enable listening on its LAN interface using Ollama's `OLLAMA_HOST`
setting and use that computer's private IP, for example `http://192.168.1.42:11434/v1`. Keep its
firewall scoped to the Garden server: standard Ollama HTTP has no authentication or encryption.
The address is always reached from the Garden server, not from the browser or phone.

The Local models choice explicitly permits HTTP to loopback and private LAN IP addresses for
that connection. It does not enable public HTTP providers or change any agent tool's approval
policy. A local endpoint can itself forward requests elsewhere; selecting this option does not
prove that a third-party server keeps data local. GPU capacity, installed models and configured
context limits belong to that inference server; garden does not provision them.

The native Garden client discovers a paired server on the same LAN while probing its saved
addresses. LAN routes get a head start; unavailable local routes do not prevent remote access.
Every route must prove the paired server's pinned TLS identity before credentials are sent.
Browser clients can open a reachable LAN address directly, but still need a certificate trusted
by that browser. LAN reachability alone does not make a self-signed certificate trusted.

Stats includes NVIDIA utilization, VRAM and temperature when `nvidia-smi` is available to the
Garden service, and AMD utilization and VRAM when the Linux driver publishes its sysfs counters.
Readings describe the Garden server, not a separate inference computer or a cloud provider.
Unsupported or inaccessible readings stay unavailable, and absent telemetry is not reported
as zero GPU use. No driver installation or privileged monitor is required by Garden.
