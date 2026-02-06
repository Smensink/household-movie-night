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
- Discovery/preference cards should clearly show lead actors, director, and studio.
- Movie descriptions should be expandable/collapsible in-card.
- Desktop should use more horizontal space, while preserving mobile-first behavior.
- In discover flow, rating a movie should immediately remove it, append a replacement at the bottom, and provide undo.
- "Haven't seen" state and rating meaning should be explicit in the UI.
- Movie metadata fetching should be cached to reduce repeated third-party API calls.

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
- Fixed Docker runtime startup by ensuring Prisma schema bootstrap (`db push`) when migrations are not present.
- Fixed Auth.js host trust errors for Docker localhost deployment.
- Fixed movie discovery/search integration key resolution to use saved Settings keys from `IntegrationConfig` (Trakt/OMDB), with environment variables as fallback.
- Added Docker build optimizations: `.dockerignore`, removed duplicate Prisma generate steps in Docker stages, and switched runtime migration command to local Prisma binary instead of `npx`.
- Aligned documented product constraints with user's original feature request.
- Added OMDB and Trakt in-memory TTL caching in API clients to reduce repeated external API requests.
- Extended movie discovery/search/session payloads to include lead actors, director(s), and studio(s); persisted metadata to DB relations from OMDB.
- Updated movie/session cards to show metadata and added expandable description UI with clear seen/unseen messaging.
- Implemented discover-list progression UX: rated item disappears, replacement appends at list bottom, and undo restores both UI and rating persistence.
- Expanded desktop content width in app layout/nav while keeping mobile-first structure.
- Added automatic default catalog bootstrapping for genres and studios when DB starts empty (no manual seed required for core preference flows).
- Added explicit preference pages for ranking genres (`/preferences/genres`) and rating studios (`/preferences/studios`) and linked them from the main preferences hub.
- Added shared household-aware preference profiling (`src/lib/preference-profile.ts`) to aggregate movie/genre/actor/director/studio affinities with user-vs-household weighting and exploration settings.
- Reworked movie discovery scoring (`/api/movies/discover`) to blend cross-signals from genre/movie/actor/director/studio preferences, discovery source preference, novelty, and household context.
- Added actor/director discovery API (`/api/people/discover`) and studio discovery API (`/api/studios/discover`) that use cross-domain signals and exploration factor; preferences pages now load ranked suggestions on entry.
- Updated people and studio preference pages to use \"rate-and-replace\" suggestion queues so the next item is contextually re-scored after each rating.
- Expanded movie metadata sync from OMDB to persist genres into `MovieGenre`, improving genre-aware matching quality in both discovery and session recommendations.
- Reworked movie-night recommendation scoring to include tonight genre ranks, era preferences, actor/director/studio/movie background preferences, household rating cohesion, exploration factor, and strong Radarr availability/monitoring preference.
- Added admin-only algorithm tuning API (`/api/settings/algorithm`) and Settings UI controls with explicit per-parameter descriptions; all new recommendation pipelines now consume these persisted tuning values.
- Clarified in-product that algorithm weights are score multipliers in ranking formulas, not direct probability-of-pool sampling controls.
- 2026-02-07:
- Added household-member account invite flow for admins:
- `HouseholdInvite` model in Prisma.
- `GET|POST /api/household/invites` for admin listing + link creation.
- `GET /api/household/invites/[token]` for public invite validation.
- `POST /api/household/invites/accept` for account creation + household join.
- New invite acceptance page at `/household-invite/[token]`.
- Added movie-night session lifecycle improvements:
- `MovieNightSession.createdByUserId` tracked on creation.
- `DELETE /api/sessions/[id]` to cancel/abort a session (creator or household admin only).
- Session payload now includes `canManage`, and session header surfaces guest token + end-session control.
- Session access now auto-adds logged-in household members to active sessions (`gathering`/`voting`) so they can join and vote separately without pre-selection.
- Dashboard now highlights active sessions (with token visibility) and adds admin invite-link management UI.
- Replaced manual session era picker with a release-year min/max range preference (Tinder age-slider style) persisted on `SessionParticipant` (`minReleaseYear`, `maxReleaseYear`), and recommendation scoring now uses year-range fit instead of era enum matching.
- Reworked preference ranking UX toward card/deck interactions:
- Movies page now emphasizes one primary card at a time, with queue behavior preserved.
- People page now uses a single rich card with progressive queue.
- Studios page now uses a single rich card and poster-hover detail overlays.
- Improved seen/unseen clarity in movie cards:
- Explicit two-state watch-status control (`Unseen` vs `Seen`) with default-unseen messaging.
- Kept star-rating semantics tied to seen-state context.
- Removed studio-rating controls from Settings page; studio rating now lives only in `/preferences/studios`.
- Updated visual direction to a more modern mobile-first look with expanded desktop width and refreshed accent/background styling.
- User preference update: user prefers high-clarity interaction copy, stronger session collaboration features (joinability + cancellation), and admin tools for household onboarding via invite links.
