# AGENTS.md

## Purpose
This repository contains a mobile-first household movie night web app. It supports:
- Background preference gathering: genre ranking, movie ratings, actor/director ratings, studio ratings, watch-state and "not heard of" signals.
- Movie-night sessions: pick present household members, collect tonight-specific preferences, generate candidate movies, vote, and decide.
- Integrations: OMDB, Trakt, Letterboxd import, Plex and Radarr configuration.

## Non-Negotiable Agent Rule
Any agent working in this repo must update this `AGENTS.md` with:
- What they learned about the codebase behavior, architecture, and edge cases.
- What they learned about the user's product preferences and workflow preferences.

Do not leave this file stale after meaningful code or behavior changes.

## User Product Preferences (Source of Truth)
The user requested:
- Two modes:
1. Background mode usable anytime for household preference collection.
2. Movie-night mode for present participants (plus guests via invite link).
- Background mode should support:
- Genre ranking.
- Movie, actor, director, and studio ratings out of 5.
- "Seen" state for movies.
- If unseen, rating means willingness to watch.
- "Haven't heard of this movie/actor/director" option.
- Movie-night mode should support:
- Session start with selected present members.
- Optional guests.
- Tonight-specific genre ranking.
- Tonight era preference: new release, modern classic, classic.
- Candidate movie sampling from background preferences + tonight preferences.
- Tonight-specific willingness-to-watch voting.
- Willingness-to-rewatch for already seen movies.
- Decision based on ratings.
- Accounts for household members, guest join via link.
- Letterboxd import.
- Radarr sync for strong background consensus movies.
- Metadata/ranking sources: Trakt, OMDB, Letterboxd.
- Availability checks via Plex/Radarr.
- Mobile-first UX (iOS/Android) and desktop compatibility.
- Modern, sleek UI.
- Docker Compose production deployment.
- Exploration vs deepening parameter in settings and adjustable on match/session screen.
- Admin-only settings for API keys/integrations.

## Current Tech Stack
- Next.js App Router (`src/app`), React, TypeScript.
- NextAuth credentials auth (`src/lib/auth.ts`).
- Prisma + PostgreSQL (`prisma/schema.prisma`).
- Tailwind v4 via CSS variables (`src/app/globals.css`).
- Docker + docker-compose for production/runtime.

## Key Directories
- `src/app`: pages and API routes.
- `src/app/api`: server endpoints for auth, households, sessions, ratings, settings, integrations.
- `src/lib`: auth, Prisma client, recommendation logic, third-party API clients.
- `prisma`: schema and seed script.
- `src/components`: UI building blocks and feature components.

## Data Model Summary
Core entities in `prisma/schema.prisma`:
- Identity and households: `User`, `Household`, `HouseholdMember`.
- Movies and metadata: `Movie`, `Genre`, `Person`, `Studio`, join tables.
- Background preferences: `GenreRanking`, `MovieRating`, `ActorRating`, `DirectorRating`, `StudioRating`, `UserSettings`.
- Sessions: `MovieNightSession`, `SessionParticipant`, `SessionGenrePreference`, `SessionMovie`, `SessionVote`.
- Integrations/import: `IntegrationConfig`, `LetterboxdImport`, `RadarrSync`, `PlexAvailability`.

## API Surface (Important)
- Auth:
- `POST /api/auth/register`
- `GET|POST /api/auth/[...nextauth]`
- Household:
- `GET|POST /api/household`
- `POST /api/household/join`
- Preferences/ratings:
- `GET|POST /api/genres`
- `GET|POST /api/ratings`
- `GET|POST /api/ratings/people`
- `GET|POST /api/ratings/studios`
- Discovery/search:
- `GET /api/movies/discover`
- `GET /api/movies/search`
- Sessions:
- `GET|POST /api/sessions`
- `GET /api/sessions/[id]`
- `GET|POST /api/sessions/[id]/movies`
- `POST /api/sessions/[id]/preferences`
- `POST /api/sessions/[id]/vote`
- `POST /api/sessions/[id]/decide`
- `POST /api/sessions/join/[code]`
- Settings/integrations/import:
- `GET|POST /api/settings`
- `GET|POST /api/integrations`
- `GET|POST /api/letterboxd`

## Security and Authorization Notes
- Session-specific routes are participant-gated.
- Integration routes are admin-gated (household admin role).
- Settings are per-user; integrations are shared config and must remain admin-only.

## Known Product/Architecture Notes
- Guest join creates signed guest tokens; session routes accept `x-guest-token` for invited guest participation without full account login.
- Recommendation scoring logic lives in `src/lib/recommendation.ts` and combines background preferences, tonight preferences, availability, and exploration factor.

## Local Development
- Install deps: `npm ci`
- Lint: `npm run lint`
- Build: `npm run build`
- Dev server: `npm run dev`
- Prisma migrate: `npm run db:migrate`
- Seed: `npm run db:seed`

## Docker
- Main runtime target is Docker Compose (`docker-compose.yml`).
- App container runs migrations on startup before serving Next standalone output.

## Agent Update Log
- 2026-02-06:
- Added stricter authorization and validation on integration/session/vote/preference flows.
- Fixed movie search results to return persisted movie IDs for rating flow correctness.
- Improved people rating flow by adding people rating GET endpoint and search extraction from OMDB details.
- Added validation for registration/settings/rating payloads.
- Implemented signed guest-token participation flow for session pages and session APIs.
- Aligned documented product constraints with user's original feature request.
