# MTWallet Backend

Backend API API for the MTWallet expense tracker. This server is the critical junction between your raw bank SMS and the AI-driven categorization engine that powers your dashboard.

## Core Features

- **SMS Ingestion Endpoint** - Optimized to securely accept batched SMS packets directly from an iOS Shortcut worker node.
- **Deterministic AI Extraction** - Processes raw SMS text securely via a highly-compressed, deterministic prompt to Gemini to extract amount, merchant, direction (expense/income), and categorized tags with minimal hallucinations.
- **Deduplication Engine Layer** - Automatically mitigates dual-SIM or repeated SMS blasts using a time-sensitive SHA-256 hash logic before storing into Supabase.
- **Push Notification Integration** - Employs encrypted VAPID keys and Web Push protocols to instantly alert your configured devices the split second a new transaction is recorded.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Create a `.env` file referencing your external services:

```bash
# Server
PORT=3001
NODE_ENV=development

# Authentication API Key (Required for iOS Shortcut requests)
API_KEY=your-secure-ingest-key

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Google AI (Gemini)
GOOGLE_GENERATIVE_AI_API_KEY=your-gemini-api-key

# Push Notifications (Web Push)
VAPID_PUBLIC_KEY=your-vapid-public-key
VAPID_PRIVATE_KEY=your-vapid-private-key
```

### 3. Run development server

```bash
npm run dev
```

## Architecture

The ingestion pipeline is designed for absolute reliability:
```
iOS Shortcut (Worker) → Backend API → Gemini AI → Supabase DB → Push Notification Event
```

1. **iOS Background Automation** intercepts SMS, batches them, and fires them to `/api/sms/ingest`.
2. Backend receives the array, validates the `API_KEY`, and computes SHA-256 deduplication hashes.
3. Backend sends distinct SMS bodies to Gemini for optimized parsing + categorization.
4. Valid, unique transactions are inserted into Supabase using the Service Role bypass.
5. VAPID Web Push triggers an asynchronous notification to subscribed devices.

## Deployment

This backend is a standard Node.js Express application, which means you can deploy it anywhere that supports Node environments (Vercel, Render, AWS, Azure, DigitalOcean, your own VPS, etc.).

```bash
# Build the TypeScript dist
npm run build

# Start the Node process
npm start
```

**Important:** Regardless of where you deploy, ensure that you securely map all 7 Environment Variables (from your `.env` file) into your cloud provider's configuration settings.
