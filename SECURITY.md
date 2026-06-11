# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security vulnerabilities.

Report privately via GitHub: **Security → Advisories → Report a vulnerability**
on this repository, or email **ashish.dav99@gmail.com**.

You can expect an acknowledgement within a few days. Please include
reproduction steps and the deployment mode (Docker, bare Node, proxy setup).

## Scope notes for self-hosters

- `POST /chat/events` should only be reachable via HTTPS, and
  the GCP project number must be set in dashboard settings — it cryptographically
  verifies that requests come from Google Chat.
- Generate a tick token (dashboard → Settings) if `/tick` is internet-reachable.
- Keep `SECRET_KEY` out of database backups — it decrypts stored credentials.
- The SQLite database contains your team's standup answers — treat backups
  accordingly.
