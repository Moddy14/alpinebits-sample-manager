# Contributing to AlpineBits Sample Manager

Thank you for your interest in contributing! 🏔️

## Ways to Contribute

### 1. Add XML Test Cases

The most valuable contributions are new XML test cases:
- **RQ/RS** — additional valid request/response examples
- **NEG** — negative test cases (XSD-valid but protocol-invalid)
- **INV** — intentionally invalid XMLs to test rejection logic

**Via the Dashboard:** Generate an XML with the KI-Generator, validate it, and click **"Als MR einreichen"** to submit directly.

**Manually:** Follow the naming convention `{TYPE}-{NN}-{kebab-description}.xml` and open a PR.

### 2. Report Issues

Found a bug or a missing edge case? [Open an issue](../../issues/new) — especially for:
- XSD validation discrepancies between spec versions
- Incorrect INV/NEG classifications
- New AlpineBits spec sections not yet covered

### 3. Improve the Dashboard

Pull requests for UI/UX improvements, new features, or bug fixes are welcome.

## Development Setup

```bash
git clone https://github.com/Moddy14/alpinebits-sample-manager.git
cd alpinebits-sample-manager
npm install
cp .env.example .env  # add your ANTHROPIC_API_KEY
npm start
```

## Code Style

- ES modules (no CommonJS)
- No build step — vanilla JS frontend
- Keep the zero-framework approach (no Express, no React)

## AlpineBits Spec Resources

- [Official Standard](https://www.alpinebits.org/hoteldata/)
- [GitLab Repository](https://gitlab.com/alpinebits/hoteldata/standard-specification)
- XSD schemas are in `/xsd/` — always validate against the target spec version
