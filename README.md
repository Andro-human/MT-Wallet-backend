# MTWallet Backend

Backend API for MTWallet expense tracker. Handles SMS parsing and categorization using AI.

## Features

- **SMS Ingestion** - Receives raw SMS, parses with Gemini AI, categorizes transactions
- **Smart Categorization** - AI picks categories based on merchant, amount, and context
- **Supabase Integration** - Direct database operations with service role

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Create a `.env` file:

```bash
# Server
PORT=3001
NODE_ENV=development

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Google AI (Gemini)
GOOGLE_GENERATIVE_AI_API_KEY=your-gemini-api-key
```

### 3. Run development server

```bash
npm run dev
```

### 4. Test the endpoint

```bash
curl -X POST http://localhost:3001/api/sms/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "api_key": "your-mtwallet-api-key",
    "messages": [
      {
        "id": 1,
        "sender": "VM-HDFCBK",
        "body": "Rs.234 spent on HDFC Card ending 5487 at SWIGGY on 2026-01-29",
        "timestamp": "2026-01-29T12:00:00Z"
      }
    ]
  }'
```

## API Endpoints

### POST /api/sms/ingest

Ingest SMS messages for parsing and categorization.

**Request:**
```json
{
  "api_key": "user-api-key-from-app",
  "messages": [
    {
      "id": 123,
      "sender": "VM-HDFCBK",
      "body": "SMS content...",
      "timestamp": "2026-01-29T12:00:00Z"
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "inserted": 5,
  "skipped": 10,
  "errors": 0,
  "total": 15
}
```

### GET /api/sms/health

Health check endpoint.

## Architecture

```
sms_sync.py (Mac) → Backend API → Gemini AI → Supabase
```

1. `sms_sync.py` reads SMS from macOS Messages database
2. POSTs raw SMS to `/api/sms/ingest`
3. Backend sends to Gemini for parsing + categorization
4. Valid transactions inserted to Supabase
5. Frontend reads directly from Supabase

## Deployment

### Azure App Service

```bash
# Build
npm run build

# Deploy (configure Azure CLI first)
az webapp up --name mtwallet-backend --runtime "NODE:20-lts"
```

### Environment Variables (Azure)

Set in Azure Portal → App Service → Configuration → Application settings:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GOOGLE_GENERATIVE_AI_API_KEY`
