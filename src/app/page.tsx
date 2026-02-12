import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-6 py-12">
      <div className="text-center space-y-6 max-w-md">
        <div className="w-20 h-20 mx-auto bg-accent-soft rounded-2xl flex items-center justify-center">
          <svg className="w-10 h-10 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" />
          </svg>
        </div>

        <div>
          <h1 className="text-3xl font-bold tracking-tight">Movie Night</h1>
          <p className="text-muted mt-2 text-sm leading-relaxed">
            No more arguments about what to watch. Rate movies, set your preferences, and let everyone pick the perfect movie together.
          </p>
        </div>

        <div className="grid gap-3 text-left">
          {[
            { title: "Rate & Discover", desc: "Rate movies, actors, and directors. Import from Letterboxd." },
            { title: "Movie Night Sessions", desc: "Start a session, invite the household, and vote on tonight's movie." },
            { title: "Smart Picks", desc: "Get recommendations based on everyone's tastes and what's available." },
          ].map((f) => (
            <div key={f.title} className="bg-card rounded-xl border border-border p-4">
              <h3 className="text-sm font-semibold">{f.title}</h3>
              <p className="text-xs text-muted mt-1">{f.desc}</p>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3 pt-2">
          <Link
            href="/register"
            className="w-full bg-accent hover:bg-accent-hover text-white font-medium py-3 rounded-xl text-center transition-all shadow-lg shadow-accent/20"
          >
            Get Started
          </Link>
          <Link
            href="/login"
            className="w-full bg-card hover:bg-card-hover text-foreground font-medium py-3 rounded-xl text-center transition-all border border-border"
          >
            Sign In
          </Link>
          <Link
            href="/setup/restore"
            className="w-full text-sm text-accent hover:underline text-center py-1"
          >
            Restore from Backup
          </Link>
        </div>
      </div>
    </div>
  );
}
