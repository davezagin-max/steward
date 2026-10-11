import { DemoBanner } from "@/components/kit/DemoBanner";
import { ThemeToggle } from "@/components/kit/ThemeToggle";
import { ExampleDemo } from "./ExampleDemo";

/** Starter page. Replace with the project's real UI; it shows the kit wired end to end. */
export default function Home() {
  return (
    <>
      <DemoBanner placeholder />
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h1 className="text-base font-semibold">Starter</h1>
        <ThemeToggle />
      </header>
      <main id="main" className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8">
        <ExampleDemo />
      </main>
      <footer className="border-t border-border px-4 py-4 text-center text-xs text-muted">
        Built with Claude Code and Claude Opus 5.5.
      </footer>
    </>
  );
}
