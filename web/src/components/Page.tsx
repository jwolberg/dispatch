import type { ReactNode } from "react";

export function Page({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section className="mx-auto max-w-6xl">
      <h1 className="mb-4 text-[17px] font-semibold text-white">{title}</h1>
      {children}
    </section>
  );
}

export function Placeholder({ note }: { note: string }) {
  return (
    <div className="rounded-md border border-border bg-surface p-6 text-body text-gray-400">
      {note}
    </div>
  );
}
