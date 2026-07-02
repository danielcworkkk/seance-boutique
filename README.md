# Boutique Full-Stack Structure

This project is now split into a clean frontend + backend setup:

- `frontend/` -> UI app (`index.html`)
- `backend/` -> Express API and data store
- `backend/data/store.json` -> Products + payment QR settings

## Quick Start

1. Install backend dependencies:
   ```bash
   cd backend
   npm install
   ```
2. Start the server:
   ```bash
   npm start
   ```
3. Open the app:
   - `http://localhost:4000`

## Firebase Sign-In Setup (Current)

The storefront now supports Firebase Authentication (email/password + email verification).

1. Create a Firebase project.
2. Enable `Authentication -> Sign-in method -> Email/Password`.
3. Open `frontend/firebase-config.js` and fill your Firebase web config.
4. Start backend and open `http://localhost:4000`.

After user verifies email and signs in, profile data is saved to backend via `POST /api/users/profile`.

## Legacy SMTP Code Flow (Optional)

If you still want backend-generated email OTP, create `backend/.env` from `backend/.env.example` and set:

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_mailbox@example.com
SMTP_PASS=your_app_password
SMTP_SECURE=false
SMTP_FROM="SÉANCE Boutique <your_mailbox@example.com>"
```

For Gmail, use an App Password (not your normal login password).

Windows PowerShell quick check:

```powershell
cd backend
npm start
```

If Firebase config is correct, customers can sign up/sign in and receive verification email from Firebase directly.

## API Endpoints

- `GET /api/health`
- `GET /api/store`
- `GET /api/products`
- `POST /api/products`
- `DELETE /api/products/:id`
- `PUT /api/payment-qr`
- `POST /api/users/profile`

Admin and operations endpoints:

- `POST /api/admin/login`
- `GET /api/admin/session`
- `GET /api/admin/orders`
- `GET /api/admin/staff`
- `POST /api/admin/staff`
- `DELETE /api/admin/staff/:id`
- `POST /api/coupons`
- `PUT /api/coupons/:code`
- `DELETE /api/coupons/:code`
- `PUT /api/shipping-rules`

## Admin Security Environment Variables

Add these to `backend/.env` for production safety:

```bash
ADMIN_JWT_SECRET=replace_with_long_random_secret
ADMIN_JWT_EXPIRES_IN=12h
ADMIN_PASSCODE=replace_with_strong_initial_password
# optional bootstrap owner allow-list
ADMIN_STAFF_EMAILS=owner@yourshop.com
```

After first login, you can add/remove staff accounts in the admin Staff tab.

## Why this structure is better

- Frontend is separated from backend concerns.
- Product and QR settings are persisted in backend data (not only browser storage).
- Admin actions now write to API, so state survives refresh/browser changes.
- Easy next step to switch from JSON file to a real database.
