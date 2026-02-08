"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface AffinityItem {
  id: string;
  name: string;
  affinity: number;
  ratingCount: number;
}

interface ProfileStats {
  user: {
    id: string;
    name: string;
    explorationFactor: number;
    discoverySourcePref: string;
  };
  counts: {
    moviesRated: number;
    moviesSeen: number;
    actorsRated: number;
    directorsRated: number;
    studiosRated: number;
    genresRanked: number;
  };
  topGenres: AffinityItem[];
  bottomGenres: AffinityItem[];
  topActors: AffinityItem[];
  bottomActors: AffinityItem[];
  topDirectors: AffinityItem[];
  bottomDirectors: AffinityItem[];
  topStudios: AffinityItem[];
  bottomStudios: AffinityItem[];
  recentHighRatedMovies: {
    id: string;
    title: string;
    year: number | null;
    posterUrl: string | null;
    rating: number;
  }[];
  ratingDistribution: {
    rating: number;
    count: number;
  }[];
  mlModel: {
    confidence: number;
    trainedEpochs: number;
    totalRatings: number;
    rmse: number | null;
    validationRmse: number | null;
    featuresLearned: number;
    lastTrainedAt: string | null;
    isTraining: boolean;
  } | null;
}

interface HouseholdMemberOption {
  id: string;
  name: string;
  ratingCount: number;
}function AffinityBar({ affinity }: { affinity: number }) {
  // affinity is -1 to 1, we need to map it to 0-100%
  const percentage = ((affinity + 1) / 2) * 100;
  const isPositive = affinity >= 0;

  return (
    <div className="w-20 h-2 bg-border rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full transition-all ${
          isPositive ? "bg-success" : "bg-error"
        }`}
        style={{ width: `${percentage}%` }}
      />
    </div>
  );
}

function AffinitySection({
  title,
  topItems,
  bottomItems,
  icon,
}: {
  title: string;
  topItems: AffinityItem[];
  bottomItems: AffinityItem[];
  icon: React.ReactNode;
}) {
  if (topItems.length === 0 && bottomItems.length === 0) {
    return null;
  }

  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-8 h-8 bg-accent-soft rounded-lg flex items-center justify-center">
          {icon}
        </div>
        <h3 className="font-semibold">{title}</h3>
      </div>

      {topItems.length > 0 && (
        <div className="mb-4">
          <div className="text-xs text-muted mb-2 uppercase tracking-wide">
            Favorites
          </div>
          <div className="space-y-2">
            {topItems.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-2"
              >
                <span className="text-sm truncate flex-1">{item.name}</span>
                <div className="flex items-center gap-2">
                  <AffinityBar affinity={item.affinity} />
                  <span className="text-xs text-muted w-10 text-right">
                    {item.affinity > 0 ? "+" : ""}
                    {(item.affinity * 100).toFixed(0)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {bottomItems.length > 0 && (
        <div>
          <div className="text-xs text-muted mb-2 uppercase tracking-wide">
            Least Preferred
          </div>
          <div className="space-y-2">
            {bottomItems.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-2"
              >
                <span className="text-sm truncate flex-1">{item.name}</span>
                <div className="flex items-center gap-2">
                  <AffinityBar affinity={item.affinity} />
                  <span className="text-xs text-muted w-10 text-right">
                    {item.affinity > 0 ? "+" : ""}
                    {(item.affinity * 100).toFixed(0)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RatingDistribution({
  distribution,
}: {
  distribution: { rating: number; count: number }[];
}) {
  const maxCount = Math.max(...distribution.map((d) => d.count), 1);

  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <h3 className="font-semibold mb-4">Rating Distribution</h3>
      <div className="flex items-end justify-between gap-2 h-24">
        {distribution.map((d) => (
          <div key={d.rating} className="flex-1 flex flex-col items-center">
            <div
              className="w-full bg-accent rounded-t transition-all"
              style={{
                height: `${(d.count / maxCount) * 100}%`,
                minHeight: d.count > 0 ? "4px" : "0",
              }}
            />
            <div className="text-xs text-muted mt-1">{d.rating}</div>
            <div className="text-xs font-medium">{d.count}</div>
          </div>
        ))}
      </div>
      <div className="text-center text-xs text-muted mt-2">Star Rating</div>
    </div>
  );
}

export default function ProfilePage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  const [stats, setStats] = useState<ProfileStats | null>(null);
  const [householdMembers, setHouseholdMembers] = useState<HouseholdMemberOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const selectedUserId =
    (typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("userId")?.trim()
      : null) ||
    session?.user?.id ||
    null;

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  useEffect(() => {
    if (status !== "authenticated" || !selectedUserId) return;

    Promise.all([
      fetch(`/api/profile/stats?userId=${encodeURIComponent(selectedUserId)}`),
      fetch("/api/household").catch(() => null),
    ])
      .then(async ([statsResponse, householdResponse]) => {
        if (!statsResponse.ok) {
          throw new Error(
            statsResponse.status === 403
              ? "You can only view profiles for members of your household"
              : "Failed to load profile stats"
          );
        }

        const statsData = (await statsResponse.json()) as ProfileStats;
        setStats(statsData);

        if (householdResponse && householdResponse.ok) {
          const households = await householdResponse.json();
          const memberMap = new Map<string, HouseholdMemberOption>();

          if (Array.isArray(households)) {
            for (const household of households) {
              if (!Array.isArray(household?.members)) continue;
              for (const member of household.members) {
                const user = member?.user;
                if (!user?.id || !user?.name) continue;
                if (!memberMap.has(user.id)) {
                  memberMap.set(user.id, {
                    id: user.id,
                    name: user.name,
                    ratingCount: user.ratingCount ?? 0,
                  });
                }
              }
            }
          }

          const members = Array.from(memberMap.values()).sort((a, b) =>
            a.name.localeCompare(b.name)
          );
          setHouseholdMembers(members);
        }

        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [selectedUserId, status]);

  if (status === "loading" || loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-error/10 border border-error/20 text-error text-sm px-4 py-2 rounded-xl">
        {error}
      </div>
    );
  }

  if (!stats) {
    return null;
  }

  const discoveryLabels: Record<string, string> = {
    popular: "Popular Movies",
    trending: "Trending Movies",
    top_rated: "Top Rated Movies",
    new_releases: "New Releases",
    indie_darlings: "Indie Darlings",
    balanced: "Balanced Mix",
    hidden_gems: "Hidden Gems",
  };

  const isOwnProfile = stats.user.id === (session?.user?.id ?? "");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">
            {isOwnProfile ? "Your Profile" : `${stats.user.name}'s Profile`}
          </h1>
          <p className="text-sm text-muted mt-1">
            What the algorithm has learned about {isOwnProfile ? "you" : stats.user.name}
          </p>
        </div>
        {isOwnProfile ? (
          <Link
            href="/preferences"
            className="text-sm text-accent hover:underline"
          >
            Edit Preferences
          </Link>
        ) : (
          <Link
            href="/profile"
            className="text-sm text-accent hover:underline"
          >
            View Your Profile
          </Link>
        )}
      </div>

      {householdMembers.length > 1 && (
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs text-muted uppercase tracking-wide mb-3">
            Household Profiles
          </div>
          <div className="flex flex-wrap gap-2">
            {householdMembers.map((member) => {
              const active = member.id === stats.user.id;
              return (
                <Link
                  key={member.id}
                  href={`/profile?userId=${member.id}`}
                  className={`px-3 py-2 rounded-lg border text-sm transition-colors ${
                    active
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-border text-foreground hover:bg-card-hover"
                  }`}
                >
                  {member.name}
                  <span className="ml-2 text-xs text-muted">{member.ratingCount}</span>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* ML Model Status */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-8 h-8 bg-accent-soft rounded-lg flex items-center justify-center">
            <svg
              className="w-4 h-4 text-accent"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
              />
            </svg>
          </div>
          <h3 className="font-semibold">Recommendation Model</h3>
          {stats.mlModel?.isTraining && (
            <span className="text-xs bg-accent/20 text-accent px-2 py-0.5 rounded-full animate-pulse">
              Training...
            </span>
          )}
        </div>
        {stats.mlModel ? (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
              <div>
                <div className="text-xs text-muted mb-1">Confidence</div>
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-2 bg-border rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        stats.mlModel.confidence > 0.7
                          ? "bg-success"
                          : stats.mlModel.confidence > 0.3
                            ? "bg-warning"
                            : "bg-error"
                      }`}
                      style={{ width: `${stats.mlModel.confidence * 100}%` }}
                    />
                  </div>
                  <span className="text-sm font-medium">
                    {(stats.mlModel.confidence * 100).toFixed(0)}%
                  </span>
                </div>
              </div>
              <div>
                <div className="text-xs text-muted mb-1">Ratings</div>
                <div className="text-sm font-medium">{stats.mlModel.totalRatings}</div>
              </div>
              <div>
                <div className="text-xs text-muted mb-1">Features</div>
                <div className="text-sm font-medium">{stats.mlModel.featuresLearned}</div>
              </div>
              <div>
                <div className="text-xs text-muted mb-1">Epochs</div>
                <div className="text-sm font-medium">{stats.mlModel.trainedEpochs}</div>
              </div>
              <div>
                <div className="text-xs text-muted mb-1">Train RMSE</div>
                <div className="text-sm font-medium">
                  {stats.mlModel.rmse !== null
                    ? stats.mlModel.rmse.toFixed(3)
                    : "N/A"}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted mb-1">Val RMSE</div>
                <div className="text-sm font-medium">
                  {stats.mlModel.validationRmse !== null
                    ? stats.mlModel.validationRmse.toFixed(3)
                    : "N/A"}
                </div>
              </div>
            </div>
            {stats.mlModel.lastTrainedAt && (
              <div className="text-xs text-muted mt-3">
                Last trained:{" "}
                {new Date(stats.mlModel.lastTrainedAt).toLocaleString()}
              </div>
            )}
          </>
        ) : (
          <div className="text-sm text-muted">
            <p>
              Not trained yet. The model requires at least 20 movie ratings across all
              household members before it can learn your preferences.
            </p>
            <p className="mt-2">
              You have rated <span className="font-medium text-foreground">{stats.counts.moviesRated}</span> movies.
              {stats.counts.moviesRated < 20 && (
                <span> Rate {20 - stats.counts.moviesRated} more to enable personalized recommendations.</span>
              )}
            </p>
          </div>
        )}
      </div>

      {/* User Settings */}
      <div className="bg-card border border-border rounded-xl p-4">
        <h3 className="font-semibold mb-3">Discovery Settings</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-xs text-muted mb-1">Exploration Factor</div>
            <div className="flex items-center gap-2">
              <div className="flex-1 h-2 bg-border rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent rounded-full"
                  style={{ width: `${stats.user.explorationFactor * 100}%` }}
                />
              </div>
              <span className="text-sm font-medium">
                {(stats.user.explorationFactor * 100).toFixed(0)}%
              </span>
            </div>
            <div className="text-xs text-muted mt-1">
              {stats.user.explorationFactor < 0.3
                ? "Prefers safe choices"
                : stats.user.explorationFactor > 0.7
                  ? "Adventurous explorer"
                  : "Balanced explorer"}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted mb-1">Discovery Preference</div>
            <div className="text-sm font-medium">
              {discoveryLabels[stats.user.discoverySourcePref] ||
                stats.user.discoverySourcePref}
            </div>
          </div>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-2xl font-bold text-accent">
            {stats.counts.moviesRated}
          </div>
          <div className="text-xs text-muted">Movies Rated</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-2xl font-bold text-accent">
            {stats.counts.moviesSeen}
          </div>
          <div className="text-xs text-muted">Movies Seen</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-2xl font-bold text-accent">
            {stats.counts.genresRanked}
          </div>
          <div className="text-xs text-muted">Genres Ranked</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-2xl font-bold text-accent">
            {stats.counts.actorsRated}
          </div>
          <div className="text-xs text-muted">Actors Rated</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-2xl font-bold text-accent">
            {stats.counts.directorsRated}
          </div>
          <div className="text-xs text-muted">Directors Rated</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-2xl font-bold text-accent">
            {stats.counts.studiosRated}
          </div>
          <div className="text-xs text-muted">Studios Rated</div>
        </div>
      </div>

      {/* Rating Distribution */}
      {stats.ratingDistribution.some((d) => d.count > 0) && (
        <RatingDistribution distribution={stats.ratingDistribution} />
      )}

      {/* Affinity Sections */}
      <div className="grid gap-4 md:grid-cols-2">
        <AffinitySection
          title="Genres"
          topItems={stats.topGenres}
          bottomItems={stats.bottomGenres}
          icon={
            <svg
              className="w-4 h-4 text-accent"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M5 3l14 9-14 9V3z"
              />
            </svg>
          }
        />

        <AffinitySection
          title="Actors"
          topItems={stats.topActors}
          bottomItems={stats.bottomActors}
          icon={
            <svg
              className="w-4 h-4 text-accent"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
              />
            </svg>
          }
        />

        <AffinitySection
          title="Directors"
          topItems={stats.topDirectors}
          bottomItems={stats.bottomDirectors}
          icon={
            <svg
              className="w-4 h-4 text-accent"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
          }
        />

        <AffinitySection
          title="Studios"
          topItems={stats.topStudios}
          bottomItems={stats.bottomStudios}
          icon={
            <svg
              className="w-4 h-4 text-accent"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
              />
            </svg>
          }
        />
      </div>

      {/* Recent High-Rated Movies */}
      {stats.recentHighRatedMovies.length > 0 && (
        <div className="bg-card border border-border rounded-xl p-4">
          <h3 className="font-semibold mb-4">Recent Favorites</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
            {stats.recentHighRatedMovies.map((movie) => (
              <div key={movie.id} className="space-y-1">
                {movie.posterUrl ? (
                  <img
                    src={movie.posterUrl}
                    alt={movie.title}
                    className="w-full aspect-[2/3] object-cover rounded-lg"
                  />
                ) : (
                  <div className="w-full aspect-[2/3] bg-border rounded-lg flex items-center justify-center">
                    <span className="text-xs text-muted">No poster</span>
                  </div>
                )}
                <div className="text-xs font-medium truncate">{movie.title}</div>
                <div className="flex items-center gap-1">
                  <svg
                    className="w-3 h-3 text-yellow-500"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                  </svg>
                  <span className="text-xs text-muted">{movie.rating}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}




















