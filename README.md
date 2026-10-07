# ExpenseTrack1 - Backend API

> Production-ready Node.js & Express payment & expense tracking backend built for **STS FINTECH PRIVATE LIMITED**.

## Features

- **Express REST API** with structured endpoints for payments and system health.
- **PostgreSQL Connection Pooling** (`pg`) with automatic SSL configuration for cloud hosting providers (Render, Supabase, Neon, AWS RDS).
- **Auto Table Initialization**: Automatically ensures the `payments` table schema exists on server startup.
- **Input Validation**: Robust validation for payment records (title, positive amounts in ₹ INR, status).
- **CORS Protection**: Configured for cross-origin integration with the ExpenseTrack frontend client.
- **Graceful Cloud & Local Fallbacks**: Resilient startup handling in various environments.

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Operational health check with company metadata |
| `GET` | `/api/payments` | Fetch all payment records (sorted newest first) |
| `POST` | `/api/payments` | Create a new payment record |

### POST /api/payments Request Body
```json
{
  "title": "Vendor Settlement - Cloud Services",
  "amount": 15499.00,
  "status": "completed"
}
```

## Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

| Variable | Description | Default |
|---|---|---|
| `PORT` | Server listening port | `5000` |
| `DATABASE_URL` | PostgreSQL connection string | `postgres://...` |
| `CLIENT_URL` | Frontend URL for CORS | `http://localhost:5173` |

## Scripts

- `npm install` - Install dependencies
- `npm run dev` - Run with hot-reloading via `nodemon`
- `npm start` - Production start via Node.js
