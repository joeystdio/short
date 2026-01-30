# Short - Link Shortener

A simple link shortener with click tracking, built with Node.js, Express, and PostgreSQL.

## Features

- 🔗 Create short links with custom or auto-generated slugs
- 📊 Track clicks with timestamp, referrer, user-agent, and country (via IP geolocation)
- 🔐 SSO authentication via auth.jdms.nl
- 👤 User-scoped data - each user only sees their own links
- 📱 Clean, responsive dashboard

## API Endpoints

### Authenticated (requires SSO session)

- `GET /api/me` - Get current user info
- `POST /api/links` - Create a short link
  - Body: `{ "url": "https://...", "slug": "optional-custom-slug" }`
- `GET /api/links` - List all your links with click counts
- `GET /api/links/:slug/stats` - Get detailed stats for a link
- `DELETE /api/links/:slug` - Delete a link

### Public

- `GET /:slug` - Redirect to original URL (tracks click)

## Deployment

```bash
docker compose up -d --build
```

Requires:
- Traefik for reverse proxy/TLS
- External network: `n8n-setup_n8n-network`

## Environment Variables

- `DATABASE_URL` - PostgreSQL connection string
- `IP_SALT` - Salt for hashing IPs (privacy)
- `PORT` - Server port (default: 3000)
