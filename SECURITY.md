# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

If you believe you have found a security vulnerability in the Lords Dashboard
backend, report it privately so it can be fixed before it is disclosed:

- **Preferred:** open a [GitHub private security advisory](https://github.com/Amitoj02/lords-dashboard-backend/security/advisories/new)
  (Security → Advisories → *Report a vulnerability*).
- **Email:** contact@amitoj.dev

Please include:

- a description of the issue and its impact,
- steps to reproduce (a proof of concept if you have one),
- the affected version / commit, and
- any suggested remediation.

We aim to acknowledge a report within **72 hours** and to provide a remediation
timeline after triage. Please give us a reasonable window to release a fix
before any public disclosure.

## Scope

This repository is the REST API backend. The Angular frontend lives in a
separate repository (`lords-regiment-dashboard`); vulnerabilities there should be
reported through that repository's security policy.

Out of scope: findings that require a compromised host or Discord bot token,
self-XSS, missing best-practice headers with no demonstrated impact, and reports
generated solely by automated scanners without a working proof of concept.

## Supported versions

This project is deployed continuously from `main`. Only the latest `main` is
supported; fixes are not backported.
