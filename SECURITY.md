# Security policy

## This is a local-first app

Second Brain stores capture, mail snippets, and secrets on the machine that runs it. Treat any issue that lets **other websites or processes** read `127.0.0.1:3000` as high severity.

## Please report privately

Do **not** open a public GitHub issue for:

- Auth bypass on the local API
- Secret or token leakage
- Ways to exfiltrate OCR, Gmail, or the encrypted store

Use [GitHub private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability) on this repository.

Include:

- Second Brain version / commit
- Windows version
- Whether the desktop app or `npm start` was used
- Steps to reproduce (no real mailbox dumps)

## What is in scope

- Local HTTP API auth (`api-token`, CORS)
- Secret storage (`secrets.enc.json`, master key)
- MCP client: command spawn, token injection, read-only tool gate
- Hosted Ask: prompts leaving the machine when the user enabled a cloud model

## What is out of scope

- “I ran `ollama serve` twice and the port was busy”
- Features that require a local model you have not pulled
- Social engineering of Google / GitHub OAuth consent screens
