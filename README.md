# 📚 FundaPlus Edu — v9

**Education platform for Zimbabwean students, powered by AI (WhatsApp + Web)**
Built by **XTech** · No Firebase · No Google Auth

---

## 🚀 What's New in v9

| Area | Change |
|---|---|
| **Auth** | Firebase completely removed. Session-based auth with hashed passwords stored in `webusers.json` |
| **Landing page** | Fully redesigned with hero, stats, features, AI section, subjects, pricing, WhatsApp CTA |
| **Login** | White split-panel design with SVG illustration |
| **Onboarding** | White split-panel with green gradient + SVG avatar |
| **Dashboard** | White theme, modern SVG hamburger, KaTeX LaTeX rendering |
| **Fundo AI** | All AI renamed from Frieno to Fundo AI |
| **Web AI** | LaTeX enabled (KaTeX rendered) |
| **Sitemap** | `/sitemap.xml` in full Google Search Console format |
| **Login page** | New `/login` route — email/password or phone/password. Gmail, Outlook, Yahoo, iCloud and other popular providers only |
| **Onboarding** | New `/onboarding` route — name, surname, age, school (Zimbabwe school list with search + "Other" option) |
| **Dashboard** | Moved to `/~`. No forced pairing on first visit. 14-day grace period with a visible warning banner |
| **Data files** | `webusers.json` (accounts), `store.json` (pairing info), `wa.json` (known WhatsApp JIDs) |
| **WA AI** | LaTeX completely removed from WhatsApp AI. Math written in plain text only |
| **Web AI** | `website/ai.js` — HTML/markdown aware, no LaTeX dollar signs |
| **Calculator** | New `commands/calculator.js` tool. AI triggers `__FRIENO_CALCULATE__` for numeric computation |
| **Quiz** | Answers and explanations shown for every failed question |
| **Sitemap** | `/sitemap.xml` auto-generated |
| **File structure** | New `website/` folder with `routes.js`, `auth.js`, `ai.js` |

---

## 📁 File Structure

```
FundaPlus-Edu/
├── bot.js                    # Express server entry point
├── store.js                  # All local storage (webusers, wa, store, usage…)
├── whatsappbaileys.js        # WhatsApp connection
├── index.js                  # App bootstrap
│
├── website/                  # ✨ NEW — all web-specific code
│   ├── routes.js             # All API + page routes
│   ├── auth.js               # Session management middleware
│   └── ai.js                 # Web AI (HTML/markdown, no LaTeX)
│
├── commands/
│   ├── ai.js                 # WhatsApp AI (plain text only, no LaTeX, no HTML)
│   ├── calculator.js         # ✨ NEW — safe math expression evaluator
│   ├── main.js               # WhatsApp message handler
│   ├── gpt-service.js        # GPT/Gemini API wrapper
│   ├── imagine.js            # Image generation
│   ├── search.js             # Web + image search
│   └── doc.js                # Document generation
│
├── utils/
│   ├── verify.js             # One-time token for WA account linking
│   ├── supabase.js           # Optional cloud sync
│   ├── pdfgen.js             # PDF generation
│   └── …
│
├── public/
│   ├── index.html            # Landing page
│   ├── login.html            # ✨ /login — sign in / create account
│   ├── onboarding.html       # ✨ /onboarding — profile setup
│   ├── resources.html        # Public resources
│   └── dashboard/
│       └── index.html        # ✨ /~ — main dashboard
│
└── data/                     # Auto-created on first run
    ├── webusers.json         # ✨ Web user accounts
    ├── store.json            # ✨ Pairing / bot connection info
    ├── wa.json               # ✨ Known WhatsApp JIDs
    ├── usage.json            # Daily usage limits
    ├── messages.json         # Message history
    ├── papers.json           # Past papers metadata
    └── …
```

---

## 🛠️ Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create `.env`

```env
PORT=3000
WEBSITE_URL=https://your-domain.com
ADMIN_PASSWORD=YourSecureAdminPassword

# AI
GEMINI_API_KEY=your_gemini_key
OPENAI_API_KEY=your_openai_key   # optional fallback

# Image generation (optional)
HF_TOKEN=your_huggingface_token

# Paynow (Zimbabwe mobile money — EcoCash / OneMoney) for subscriptions
# Get these at https://www.paynow.co.zw after creating an integration.
PAYNOW_INTEGRATION_ID=your_integration_id
PAYNOW_INTEGRATION_KEY=your_integration_key
# The email registered on your Paynow merchant account (used as authemail)
PAYNOW_MERCHANT_EMAIL=you@example.com

# Cloud sync (optional)
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=your_service_key
```

### 3. Run

```bash
node index.js
```

---

## 🌐 Web Routes

| Route | Description |
|---|---|
| `/` | Landing page |
| `/login` | Sign in or create account |
| `/onboarding` | Profile setup (after registration) |
| `/~` | Dashboard (home, AI chat, quiz, papers, pairing) |
| `/~/account` | Account settings |
| `/~/subscription` | Plans, wallet balance & Paynow checkout |
| `/resources` | Public resource library |
| `/admin-hidden` | Admin panel |
| `/sitemap.xml` | Auto-generated sitemap |

---

## 🔐 Auth Flow

```
Register → /login (create account)
         ↓
         /onboarding (name, surname, age, school)
         ↓
         /~ (dashboard)
              ↓
              First 14 days: warning banner to link WhatsApp
              After 14 days: pairing becomes required
```

**Allowed email providers:** Gmail, Googlemail, Outlook, Hotmail, Live, Yahoo, iCloud, Proton, Zoho, AOL, Mail.com, Yandex, MSN

---

## 📧 Email System (two accounts + activity log)

The admin Email page (`/fundopageadmin` → Email) manages **two separate email accounts**, each with its own login, app password and Test connection:

| Account | Used for | Who sends |
|---|---|---|
| **System email** (automatic) | Verification codes & forgot-password codes | The system, by itself |
| **Mailing email** (admin messages) | Emails the admin writes to one user, several users, or all users | Admin, from the Email page |

- **Test connection** only checks the login with the mail server — it sends nothing.
  **Send test** (enter an address) also delivers a real email so you can confirm it arrives.
- **Compose** — subject + message, sent through the mailing account (recipients are BCC'd in batches).
- **Email activity log** — every email sent by the system (codes) or by an admin (messages & tests),
  including failures with the error. Stored in `data/email-log.json`, capped at 500 entries.

Forgot-password / resend-code feedback:
- Can't send → **"Email service is currently unavailable. Please try again in a few minutes."**
- Sent → **"Code sent! Check your inbox — if it doesn't appear, check your spam folder."**

SMTP config lives in `data/smtp.json` under `system` and `mailing` (an old flat config is migrated to `system` automatically). Gmail users: each account needs its own [App Password](https://myaccount.google.com/apppasswords).

### 🌉 Mail bridge (when the host blocks SMTP — e.g. Railway free tier)

Railway free blocks outbound SMTP. Deploy [Fundo Mail Bridge](https://github.com/theguyzoz/Fundo-Mail-Bridge)
on a host that allows it (Render, Koyeb, Fly, VPS…), then in
**Admin → Email → Mail bridge** paste the bridge URL + API key and Save.
When the bridge is ON, all mail (codes + admin messages) travels over HTTPS to
the bridge, which does the SMTP part. SMTP credentials still live in Fundo Plus
and ride with each request — the bridge is stateless. Turn it off anytime to
send directly again.

---

## 💳 Subscriptions — Wallet, Paynow Top-up, Withdrawals

The subscription page (`/~\/subscription`) now uses a **virtual wallet (USD)**:

1. **Top up** the wallet via [Paynow](https://www.paynow.co.zw) (EcoCash / OneMoney). The wallet caps at **$10.00 USD** — the max top-up is the remaining capacity.
2. **Buy a plan** (Lite $2 / Plus $5 / Pro $7 per month) using wallet balance.
3. **Withdraw** balance to a mobile-money number. A **5% fee** applies on cash-out, so the *withdrawal balance* is always 5% below the virtual balance (see `TRANSACTION_FEE_PCT`).

`POST /api/topup` initiates a Paynow payment and stores a *pending deposit*; the page **polls `GET /api/subscription/poll?reference=...` every 4s** until confirmation, and the wallet is credited (idempotently) via the webhook or poll.

**Backend endpoints**

| Endpoint | Purpose |
|---|---|
| `POST /api/topup` | Initiate Paynow top-up (body: `{ amount, method, phone }`) — amount validated/capped server-side |
| `POST /api/paynow/update` | Paynow status-update **webhook** (hash-verified, credits wallet) |
| `GET /api/subscription/poll?reference=` | Client poll — also polls Paynow server-side as fallback |
| `POST /api/subscription/activate` | Buy a plan with wallet balance (body: `{ plan }`) |
| `POST /api/withdraw` | Request a withdrawal (5% fee, body: `{ amount, phone }`) |
| `GET /api/withdrawals` | List my withdrawals |
| `GET /api/billing/status` | Balance, withdrawal balance, remaining top-up, transactions |
| `GET /api/admin/withdrawals` · `POST /api/admin/withdrawal/:id/complete` · `:id/fail` | Admin payout review |

**Security (anti-free-money hardening)**

- All amounts are computed **server-side** — the client can never set a credited/debited amount.
- `sanitizeCents()` rejects NaN, negatives, >2-decimal, and absurd values.
- Balance ops are **atomic** and enforce the `$10` cap and never go negative.
- Deposit finalization is **idempotent** (replay-safe webhook/poll).
- Withdrawals debit atomically and **refund on failure** so money can't vanish.
- Money endpoints are **rate-limited**.
- Withdrawals require a valid Zimbabwe mobile number.

**Config constants** (in `store.js`): `MAX_BALANCE_CENTS` ($10), `MIN_TOPUP_CENTS` ($1), `TRANSACTION_FEE_PCT` (5), `FEE_ON_DEPOSIT` (false — fee applies on withdrawal).

**Data files** (auto-created under `data/`): `balances.json`, `pending_deposits.json`, `withdrawals.json`.

> Set `PAYNOW_INTEGRATION_ID`, `PAYNOW_INTEGRATION_KEY` and `PAYNOW_MERCHANT_EMAIL` in your environment, and make sure `WEBSITE_URL` points at your public domain (used for the Paynow result/return URLs).

---

## 📱 WhatsApp AI Rules

- No LaTeX (`$...$`, `$$...$$`, `\frac`, `\sqrt`) — these break in WA
- No HTML tags
- Math in plain text: `x = (-b ± sqrt(b²-4ac)) / 2a`
- WhatsApp markdown only: `*bold*`, `_italic_`, `` `code` ``

---

## 🧮 New: Calculator Tool

The WA AI can now trigger the calculator for numeric expressions:

```
User: what is sqrt(144) + 5^2
Fundo AI: 🧮 Calculator
        sqrt(144) + 5^2 = 37
```

Supports: `+`, `-`, `*`, `/`, `^`, `sqrt()`, `sin()`, `cos()`, `tan()`, `log()`, `ln()`, `abs()`, `pi`, `e`

---

## 📝 Quiz — Answer Explanations

After submitting a quiz, every wrong (or skipped) answer shows:
- ✅ The correct answer highlighted in green
- 💡 A full explanation of why that answer is correct

---

## 🗺️ Sitemap

`GET /sitemap.xml` returns a valid XML sitemap. Customize pages in `website/routes.js`.

---

## 🔑 Data Files

| File | Contents |
|---|---|
| `data/webusers.json` | User accounts (email, hashed password, profile, JID link) |
| `data/store.json` | WhatsApp bot pairing/connection info |
| `data/wa.json` | All known WhatsApp JIDs ever seen |
| `data/usage.json` | Daily usage per JID/user |
| `data/papers.json` | Past papers metadata |
| `data/messages.json` | Conversation history |

---

## 🏗️ Deployment (Railway / Render)

1. Push to GitHub
2. Add environment variables in the dashboard
3. Set start command: `node index.js`
4. Ensure the `data/` folder is persisted (Railway persistent disk or Supabase sync)

---

*FundaPlus Edu by XTech — Empowering Zimbabwe's students* 🇿🇼
