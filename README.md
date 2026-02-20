# 🏔️ AlpineBits Sample Manager

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org)
[![AlpineBits](https://img.shields.io/badge/AlpineBits-2018--10%20to%202024--10-blue.svg)](https://www.alpinebits.org)
[![Live Demo](https://img.shields.io/badge/Live%20Demo-alpinebits.moddy--blossom.at-brightgreen.svg)](https://alpinebits.moddy-blossom.at)

> A professional web dashboard for managing, validating, and AI-generating [AlpineBits HotelData](https://www.alpinebits.org) XML test samples — covering all 7 protocol sections across 4 spec versions (2018-10 through 2024-10).

---

## ✨ Features

| Feature | Description |
|---|---|
| **🏛️ Official Samples** | Live-loaded from the [AlpineBits GitLab repository](https://gitlab.com/alpinebits/hoteldata/standard-specification) |
| **📦 Local Test Suite** | 141 curated XML test cases (2.6× more than official) with full RQ/RS/NEG/INV coverage |
| **⚖️ Side-by-Side Comparison** | Visual diff of official vs. local samples, grouped by message type |
| **📊 Batch Validation Run** | One-click validation of all XMLs against any spec version with smart INV logic |
| **🤖 AI XML Generator** | Claude Opus-powered generation of valid AlpineBits XMLs from natural language |
| **🔢 Multi-Version XSD** | Validates against 2018-10, 2020-10, 2022-10, and 2024-10 schemas |
| **🔄 XSD Freshness Check** | Checks remote XSD hashes every 12h — alerts when schemas change |
| **✨ Dynamic Sections** | New AlpineBits sections auto-discovered and AI-bootstrapped (emoji + context) |
| **📥 Export Reports** | Timestamped validation reports with XSD hash fingerprint |
| **🔀 GitLab MR Integration** | Submit AI-generated samples as Merge Requests to the upstream repository |

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** ≥ 18.0
- **xmllint** for XSD validation: `apt install libxml2-utils`
- **Anthropic API Key** for AI generation: [console.anthropic.com](https://console.anthropic.com)

### Installation

```bash
git clone https://github.com/Moddy14/alpinebits-sample-manager.git
cd alpinebits-sample-manager

npm install

cp .env.example .env
# Add your ANTHROPIC_API_KEY to .env

npm start
```

Open [http://localhost:3210](http://localhost:3210) in your browser.

---

## 📁 Project Structure

```
alpinebits-sample-manager/
├── server.js              # Node.js HTTP server (ES modules, zero framework)
├── package.json
├── .env.example           # Environment variable template
├── sections-meta.json     # Auto-generated section metadata (emoji + AI context)
├── public/
│   ├── index.html         # Single-page dashboard
│   ├── style.css          # Dark mode UI
│   └── app.js             # Vanilla JS frontend
└── xsd/
    ├── versions.json      # Version registry with hashes + remote sync status
    ├── 2018-10.xsd
    ├── 2020-10.xsd
    ├── 2022-10.xsd        # Default validation schema
    └── 2024-10.xsd        # Latest spec
```

---

## 🔧 Configuration

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | *(required)* | Get yours at [console.anthropic.com](https://console.anthropic.com) |
| `PORT` | `3210` | HTTP server port |

The server loads `.env` automatically — no external dependency needed.

---

## 📊 Validation Logic

The batch runner applies type-aware logic:

| XML Type | Expected XSD Result | Counts as ✅ when... |
|---|---|---|
| **RQ** / **RS** | Valid | `xmllint` passes |
| **NEG** | Valid | `xmllint` passes (business-logic rejection tested separately) |
| **INV** | **Invalid** | `xmllint` **fails** — intentionally broken test cases |

> **Notable finding:** 5 INV files fail correctly only against **2024-10** (not 2022-10),
> because `HotelCode` was incompletely required in the 2022-10 XSD — a known spec weakness
> fixed in 2024-10.

---

## 🔢 AlpineBits Protocol Sections

| Section | OTA Messages | Official | Ours |
|---|---|---|---|
| 🤝 Handshake | OTA_PingRQ/RS | 5 | 19 |
| 🛏️ FreeRooms | OTA_HotelInvCountNotifRQ/RS | 8 | 41 |
| 🎿 ActivityData | OTA_HotelPostEventNotifRQ/RS | 4 | 15 |
| 💶 BaseRates | OTA_HotelRatePlanRQ/RS | 2 | 12 |
| 👤 GuestRequests | OTA_ReadRQ + OTA_HotelResNotifRQ/RS + OTA_NotifReportRQ | 10 | 20 |
| 🏨 Inventory | OTA_HotelDescriptiveContentNotifRQ/RS | 5 | 15 |
| 📋 RatePlans | OTA_HotelRatePlanNotifRQ/RS | 7 | 19 |

---

## 🤖 AI Generator

Uses **Claude claude-opus-4-6** with full AlpineBits spec context:

- Auto-selects reference examples from the official repository
- Applies correct namespaces, version attributes, and OTA message structure
- Generates realistic test data (Hotel `Frangart Inn`, dates `2022-08-xx`)

**Rate limits:** 20 calls/day on the shared pool. Enter your own `sk-ant-...` key for unlimited use — keys never leave your browser.

---

## 📁 Local Sample Storage

```
/your/local/path/
├── Handshake/
│   ├── RQ-01-standard-ping.xml
│   ├── NEG-01-unknown-actions.xml
│   └── INV-01-missing-version-attr.xml
├── FreeRooms/
└── ...
```

Naming convention: `{TYPE}-{NN}-{kebab-description}.xml`

Configure the path via the `LOCAL_DIR` constant in `server.js`.

---

## 📖 AlpineBits Resources

- [AlpineBits Website](https://www.alpinebits.org)
- [Official GitLab Repository](https://gitlab.com/alpinebits/hoteldata/standard-specification)
- [AlpineBits Standard Documentation](https://gitlab.com/alpinebits/hoteldata/standard-specification/-/tree/master/asciidoc)
- [OpenTravel Alliance Schema](https://opentravel.org)

---

## 🤝 Contributing

The dashboard has built-in **GitLab MR Integration**: generate or craft an XML, validate it, then click **"Als MR einreichen"** to submit it directly to the official AlpineBits repository.

Issues and pull requests are welcome!

---

## 📄 License

MIT © 2026 [Moddy14](https://github.com/Moddy14)

---

*Built for the AlpineBits community. Powered by [Claude AI](https://www.anthropic.com).*
