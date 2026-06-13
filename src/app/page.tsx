import AgentHero from "@/components/home/AgentHero";
import HowItWorks from "@/components/home/HowItWorks";
import TrustSection from "@/components/home/TrustSection";

/**
 * Merchant landing page: one URL input that routes straight into the agent
 * (hero), the 3-step story, and the safety guarantees.
 */
export default function HomePage() {
  return (
    <div className="mx-auto max-w-4xl">
      <AgentHero />
      <HowItWorks />
      <TrustSection />
    </div>
  );
}
