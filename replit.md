# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: None (memory-only by design — ephemeral shares)
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Application: VaultDrop — Secure Ephemeral Data Exchange Platform

A zero-knowledge, one-time file and text sharing platform. Encrypted client-side with AES-GCM (Web Crypto API). Data auto-deletes after access or TTL expiry.

### Key Features
- Client-side AES-GCM encryption (Web Crypto API), key embedded in URL fragment
- Optional password protection (PBKDF2-derived key)
- Configurable TTL: 1m, 15m, 1h, 36h, 1d, 4d
- One-time access: share deleted after receiver downloads/copies
- Rate limiting: 3 shares/minute per IP
- Optional webhook notifications (fire-and-forget)
- Dark/Light mode, PWA-capable, WCAG 2.1 AA
- Health endpoint with random API key (printed at startup)

### Architecture

#### Frontend (artifacts/ephemeral-share)
- React + Vite at path `/`
- Wouter for routing
- framer-motion for animations
- next-themes for dark/light mode
- jszip for ZIP downloads

#### Backend (artifacts/api-server)
- Express 5, in-memory share store
- No database — all shares stored in RAM
- Routes: POST /api/shares, GET /api/shares/:id, GET /api/shares/:id/peek, DELETE /api/shares/:id, POST /api/webhook/test
- Health: GET /api/healthz (public), GET /api/health (API key required)
- Security headers: HSTS, X-Frame-Options, CSP, etc.

### Share Encryption Flow
1. Sender generates 32-byte random key + 12-byte IV
2. AES-GCM encryption of payload (text+files as JSON)
3. **No password**: raw key in URL fragment (`#key=[base64url]`)
4. **With password**: PBKDF2 derives a key from password, encrypts the raw key → encrypted key goes in URL fragment (`#key=[base64-encryptedKey]`); salt stored on server
5. Encrypted data POSTed to server (key NEVER sent to server)
6. Receiver extracts fragment, fetches data, decrypts: without password → use key directly; with password → use password + salt to recover key, then decrypt

### Pages
- `/` — SenderPage: text/file tabs, TTL picker, password toggle (PBKDF2), webhook section, rate-limit countdown
- `/share/:shareId` — ReceiverPage: peek → warning → access → decrypt → copy/download → auto-delete → done
- `*` — NotFound: friendly dog mascot with humorous messages

### Key Bug Fixes Applied
- Memory check now uses `os.freemem()` (not heap-only) so it works in dev environments
- Vite proxy `/api/*` → `http://localhost:8080` for dev API access
- Password flow: encrypted key (not raw key) goes in URL when password is enabled
- TypeScript strict Uint8Array compatibility with Web Crypto API

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
