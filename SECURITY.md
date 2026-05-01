# Security Policy

## Reporting a vulnerability

Please do not report security issues through public GitHub issues, discussions, or pull requests.

Instead, use GitHub's [private vulnerability reporting](https://github.com/dankhole/quarterdeck/security/advisories/new) to open a private advisory. This routes the report directly to the maintainers and keeps details off the public tracker until a fix is ready.

When reporting, please include:

- A description of the issue and its impact.
- Steps to reproduce, or a minimal proof of concept.
- The Quarterdeck version (`quarterdeck --version`) and your OS / Node version.
- Any suggested mitigation, if you have one.

You should expect an initial response within a few business days. Coordinated disclosure timing will be agreed on a case-by-case basis.

## Supported versions

Quarterdeck is pre-1.0 and under active development. Only the latest published release on npm receives security fixes. Older versions will not be patched; upgrade to the latest release instead.

## Scope

In scope:

- The `quarterdeck` CLI and runtime server.
- The bundled web UI served by the runtime.
- Build, packaging, and release tooling in this repository.

Out of scope:

- Vulnerabilities in third-party agent CLIs (`claude`, `codex`, `pi`). Report those to the respective upstream projects.
- Issues that require already having local code execution on the machine running Quarterdeck, since the runtime is intended to be run locally by the user who owns the repository.
