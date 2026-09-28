# Third-party notices

garden is licensed under the repository [AGPL-3.0 license](LICENSE). Dependencies retain their own
licenses; releases must include a reviewed SBOM and pass `pnpm license:check`.
The native-client crate graph must also pass `pnpm license:rust`; a newly introduced license
expression fails closed until it has a distributable path approved in that gate.

## Independent product

garden is an independent implementation. It does not copy or embed any other product's code,
prompts, prose, branding, or assets, and is not affiliated with, endorsed by, or derived from any
other agent or chat product.

If third-party code is ever incorporated, maintainers must first review the exact revision and
preserve every required copyright, permission, source, attribution, trademark, and network-use
notice, and record it in this file.

## User-installed publisher tools

Codex CLI and Claude Code are not bundled in the repository image. With explicit approval, garden
installs the current official npm package into the owner’s persistent workspace:

- `@openai/codex`
- `@anthropic-ai/claude-code`

The owner authenticates directly with the publisher and is responsible for subscription eligibility,
service terms, usage limits, and acceptable use. garden does not sell, sublicense, pool, or transfer
those subscriptions.

## External services

OpenRouter and other OpenAI-compatible providers, MCP servers, GitHub, WebDAV providers, destination
sites, VPS/cloud hosts, push relays, DNS providers, certificate authorities, app stores, and network
operators are optional external services selected by the owner. Their terms, privacy policies,
pricing, licenses, availability, and content rules apply separately.

An API model identifier is not proof of an open-source or open-weight license. garden does not
download model weights and does not represent third-party models as part of this software license.

## Media and user content

The owner is responsible for rights in inputs and outputs, including training-data restrictions,
voices, likenesses, trademarks, copyrighted source material, generated media, and content submitted
to destination services.
