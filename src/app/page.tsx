import AgentHero from "@/components/home/AgentHero";
import HowItWorks from "@/components/home/HowItWorks";
import TrustSection from "@/components/home/TrustSection";
import CrawlHistory from "@/components/home/CrawlHistory";
import SavedSchemasList from "@/components/home/SavedSchemasList";

/**
 * Merchant landing page: one URL input that routes straight into the agent
 * (hero), the 3-step story, the safety guarantees, and — secondary, below the
 * fold — previous crawls and saved schemas (`#history`, linked from the nav).
 */
export default function HomePage() {
  return (
    <div className="mx-auto max-w-4xl">
      <AgentHero />
      <HowItWorks />
      <TrustSection />
      <section id="history" className="scroll-mt-16">
        <CrawlHistory />
        <SavedSchemasList />
      </section>
    </div>
  );
}
