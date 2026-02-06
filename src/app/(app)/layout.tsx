"use client";

import NavBar from "@/components/NavBar";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh pb-20">
      <main className="max-w-lg sm:max-w-3xl lg:max-w-5xl xl:max-w-7xl mx-auto px-4 sm:px-6 py-6">
        {children}
      </main>
      <NavBar />
    </div>
  );
}
