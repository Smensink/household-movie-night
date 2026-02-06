"use client";

import NavBar from "@/components/NavBar";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh pb-20">
      <main className="max-w-lg mx-auto px-4 py-6">{children}</main>
      <NavBar />
    </div>
  );
}
