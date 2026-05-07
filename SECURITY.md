# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 2.1.x   | Yes                |
| 2.0.x   | Security fixes only|
| < 2.0   | No                 |

## Reporting a Vulnerability

The maintainers take security seriously. If you discover a security vulnerability in this project, please report it responsibly.

### How to Report

**Preferred:** Open a [GitHub Security Advisory](https://github.com/vbiyani3107/demoenvservicenowmcp/security/advisories/new) for this repository (private submission).

Please include:
- A description of the vulnerability
- Steps to reproduce the issue
- The potential impact
- Any suggested fixes (optional)

### What to Expect

- **Acknowledgment:** We will acknowledge receipt of your report within 48 hours.
- **Assessment:** We will investigate and assess the severity within 5 business days.
- **Resolution:** We aim to release a fix for critical vulnerabilities within 14 days.
- **Disclosure:** We will coordinate public disclosure with you after a fix is available.

### What We Ask

- **Do not** open a public GitHub issue for security vulnerabilities.
- **Do not** exploit the vulnerability beyond what is necessary to demonstrate it.
- **Do** give us reasonable time to address the issue before public disclosure.

## Security Considerations

This project connects to ServiceNow® instances using credentials you provide. Please observe the following best practices:

- **Never commit credentials** to version control. Use environment variables or the `config/servicenow-instances.json` file (which is `.gitignore`d).
- **Use least-privilege accounts** for API access. Avoid using `admin` credentials in production.
- **Rotate credentials** regularly, especially if they may have been exposed.
- **Use HTTPS only** when connecting to ServiceNow® instances.
- **Review ACLs** on your ServiceNow® instance to ensure the API user has appropriate access controls.

## Scope

This security policy covers the Demo Env ServiceNow MCP source code and its direct dependencies. It does not cover:

- Your ServiceNow® instance configuration or security posture
- Third-party plugins or extensions
- Forked or modified versions of this project
