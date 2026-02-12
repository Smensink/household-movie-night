# Redesign Plans

## Purpose
Capture the main product flows, how they currently work, and how they should work in a future UI/UX redesign.

## Product-Level Interaction Goals
- Mobile-first, one-handed interactions as the default.
- Clear step-by-step guidance in every multi-step flow.
- Immediate feedback after every action (save, rate, vote, invite, sync).
- Consistent interaction patterns across rating surfaces.
- Progressive disclosure: simple first, details on demand.

## 1) Auth, Onboarding, and Recovery
### Current
- Users land on intro/login/register pages.
- Restore-from-backup entry points exist on intro/login.
- Household context appears after login.

### Should Be
- Unified onboarding wizard:
  1. Create account or accept invite.
  2. Join/create household.
  3. Optional data import (Letterboxd).
  4. Start preference calibration.
- Recovery should be a first-class path in onboarding with clear "new setup" vs "restore existing setup" choice.

## 2) Household Management and Invites
### Current
- Admin can create invite links for household members.
- Members can join via invite acceptance route.
- Dashboard shows active sessions and invite controls.

### Should Be
- Dedicated "Household" area:
  - Members list with roles, status, and activity.
  - Invite lifecycle status (pending, accepted, expired).
  - Quick actions: copy invite, resend, revoke.
- Make admin-only actions visually distinct and grouped.

## 3) Background Preferences Hub
### Current
- Preferences are split across pages:
  - Genres
  - Movies
  - People (actors/directors)
  - Studios
  - Upcoming
  - Near Radarr threshold
- Flows are mostly card-based/tinder-style for entity rating.

### Should Be
- Keep split-by-entity pages, but add a guided "calibration track":
  - Starter queue that rotates movies/people/studios to collect enough signal quickly.
  - Progress meter by signal quality (not only count).
- Add explicit "What this rating means" copy consistently:
  - Seen = liking.
  - Unseen = willingness to watch.

## 4) Genre Ranking UX
### Current
- GenreRanker supports tap-to-select + reorder arrows + save.
- Used in preferences and session contexts.

### Should Be
- Dedicated ranked-list interaction with drag handles (mobile-safe).
- Better "order confidence" cues:
  - Top 3 emphasized visually.
  - Optional quick presets ("Action night", "Family night", etc.).
- Context-specific CTA labels (for example session: "Save Tonight Preferences & Start Rating").

## 5) Movie Rating (Background Mode)
### Current
- TinderMovieCard with poster, metadata, seen/unseen toggle, stars, not-heard-of.
- Queue preloading and replace-on-rate behavior with undo.

### Should Be
- Keep full-screen card model.
- Add stronger swipe affordances:
  - Vertical or horizontal gestures mapped to star shortcuts (optional).
  - Explicit "tap stars" remains primary.
- Keep metadata compact by default; expand into drawer/sheet for details.

## 6) People and Studio Rating
### Current
- Rich cards with metadata, plus studio sample posters.
- Replace-on-rate behavior.

### Should Be
- Standardize card anatomy with movie cards so users do not relearn controls.
- Add better explanation of why each suggestion appears ("because you liked X").
- For studios, keep poster hover/peek details and add tap fallback on mobile.

## 7) Movie Night Session Flow
### Current
- Multi-step flow exists:
  - Preferences
  - Voting
  - Leaderboard
  - Decided
- Voting uses TinderMovieCard.
- Leaderboard supports editing ratings and final decision.

### Should Be
- Explicit guided wizard with sticky next action in each step.
- "Start voting" should only appear after required preferences are saved.
- Add live participation status:
  - Who has completed preferences.
  - Who is actively voting.
  - Remaining signal until leaderboard unlock.
- Keep continuous queue model and make queue rationale inspectable.

## 8) Profile and Archetype Insights
### Current
- Profile includes affinities, model stats, archetype summary, and example movies.
- Includes "Most Loved", "Uniquely Loved", and "Uniquely Avoided" rows.
- Inline quick-rating on posters.

### Should Be
- Organize profile into tabs:
  - Taste Summary
  - Archetype
  - Rating History
  - Compare with Household
- Keep actionable posters, but reduce cognitive load:
  - One compact action bar per card.
  - Optional compare mode for another member.

## 9) Radarr/Plex and Threshold Queues
### Current
- Near-threshold queue exists for member rating support.
- Sync and availability pathways are present in settings/admin APIs.

### Should Be
- Unified "Library Pipeline" page:
  - Near-threshold titles.
  - In library / downloading / watched states.
  - Why a title is close or blocked.
- Keep seen/unseen and rating controls available directly in queue rows/cards.

## 10) Settings and Algorithm Controls
### Current
- Settings include integrations and algorithm tuning with parameter descriptions.
- Some controls are admin-only.

### Should Be
- Split into:
  - Personal settings
  - Household settings
  - Admin integrations
  - Algorithm lab (advanced)
- Add presets for algorithm tuning (Conservative, Balanced, Discovery-heavy) with explainers.

## 11) System Jobs, Training, and Transparency
### Current
- Overnight retrain scheduling and GPU gating exist.
- Evaluation endpoints exist for MF and hybrid comparisons.

### Should Be
- "Model Health" admin panel:
  - Last train time, dataset size, top metrics, drift indicators.
  - One-click evaluation snapshots with historical trend chart.
- Surface "why this recommendation" explanations in user-facing flows.

## 12) Global UI System Direction
### Current
- Modern card-based UI with mobile-first layout and improved desktop width use.

### Should Be
- Consolidated design system tokens and component states:
  - Spacing, typography scale, component density modes.
  - Unified button hierarchy and semantic colors.
- Accessibility baseline:
  - Better focus states.
  - Larger touch targets.
  - Consistent keyboard interactions.

## Execution Notes
- Preserve existing backend behavior and recommendation logic while redesigning UI.
- Favor incremental rollout by feature area to reduce regression risk.
- Keep all high-friction actions reversible (undo, edit, cancel) where possible.
