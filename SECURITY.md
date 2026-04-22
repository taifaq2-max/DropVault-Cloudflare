# Security Policy

## Supported Versions

VaultDrop is currently in active early development. Only the latest commit on the `main` branch receives security patches.

| Version      | Supported          | Notes                          |
| ------------ | ------------------ | ------------------------------ |
| `main` (HEAD) | :white_check_mark: | Active development branch      |
| Any prior tag | :x:                | No backport patches            |

Once stable releases begin (1.0+), this table will be updated to reflect the LTS and current stable policy.

---

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security-related items.**

We take the security of VaultDrop seriously. Because VaultDrop handles sensitive, ephemeral data, responsible disclosure is especially important. If you believe you have found a vulnerability, please report it through one of the following channels:

- **GitHub Private Vulnerability Reporting (preferred):** Navigate to the **Security** tab of this repository and select **"Report a vulnerability."** This is the most secure and streamlined method.
- **Email:** Contact the maintainer directly at the email address listed on the GitHub profile, marking the subject line with `[SECURITY]`.

### What to Include

To help us triage your report quickly, please provide:

1. A descriptive title.
2. A clear description of the vulnerability and the component it affects.
3. Steps to reproduce the issue (proof-of-concept scripts or screenshots are highly encouraged).
4. The potential impact (e.g., data exposure, key material leakage, replay attack).

### Our Commitment

When you report a vulnerability, you can expect:

- **Acknowledgement** — We will acknowledge receipt of your report within **48 hours**.
- **Triage** — We will provide a preliminary assessment within **5 business days**.
- **Confidentiality** — Details of the report will remain confidential until a fix is released.
- **Recognition** — With your permission, we will credit you for the discovery in the release notes.

---

## Security Design Notes

VaultDrop is built with a zero-knowledge architecture. The following properties are intentional and relevant when evaluating the attack surface:

- **Client-side encryption only.** Encryption and decryption happen entirely in the browser using the Web Crypto API (AES-GCM / ChaCha20-Poly1305). The server never sees plaintext data or encryption keys.
- **Keys in the URL fragment.** The encryption key is embedded in the `#` fragment of the share link. Fragments are not sent to the server in HTTP requests.
- **Ephemeral, memory-only storage.** Share data is held in memory and automatically purged after a single access or when the configured TTL expires. There is no database persistence.
- **Bot protection.** hCaptcha is required on share creation and access. A server-side nonce system prevents captcha token reuse across requests.
- **Rate limiting.** Share creation is limited to 3 requests per minute per IP address.
- **Optional password protection.** An additional passphrase can be required to decrypt a share, derived via PBKDF2.

---

## Security Best Practices for Self-Hosters

If you are running your own instance of VaultDrop:

- Keep your Node.js runtime and all dependencies up to date.
- Enable [GitHub Dependabot](https://docs.github.com/en/code-security/dependabot) on your fork to receive automated dependency alerts.
- Always set `HCAPTCHA_SECRET_KEY` and `HCAPTCHA_SITE_KEY` in production — hCaptcha protection is disabled when these are absent.
- Run the application behind HTTPS. Keys in URL fragments are only safe when the connection is encrypted in transit.
- Review the `docker/` configuration and ensure the container is not exposed to the public internet without a reverse proxy.
