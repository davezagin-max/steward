import { DemoBanner } from "@/components/kit/DemoBanner";
import { Workbench } from "@/components/steward/Workbench";
import { DEMO_BUNDLE } from "@/lib/steward/bundle";

/**
 * One screen: the bundled sample, already profiled, with suggestions waiting for review.
 * Everything a visitor sees first is computed ahead of time and shipped with the page.
 */
export default function Home() {
  return (
    <>
      <DemoBanner placeholder={DEMO_BUNDLE.meta?.placeholder ?? false} />
      <Workbench />
      <footer className="border-t border-border bg-bg px-4 py-3 text-center text-xs text-muted">
        Sample data is synthetic: no real people, loans, or identifiers. Built with Claude Code and Claude Opus 5.5.
      </footer>
    </>
  );
}
