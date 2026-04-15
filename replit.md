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
3. Encrypted data POSTed to server
4. Key embedded in URL fragment: `/share/[id]#key=[base64url]`
5. Receiver extracts key from fragment, fetches encrypted data, decrypts
6. If password: PBKDF2-derived key encrypts the main key (salt stored on server)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
