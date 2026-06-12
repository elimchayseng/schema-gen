/**
 * The 3-step "how it works" strip: Scan → Validate & Fix → Inject & Prove.
 * Static server component in the homepage card motif. Color rules: indigo for
 * the AI/fix step, emerald for scan/proof — never orange outside warnings.
 */

const STEPS = [
  {
    num: 1,
    title: "Scan",
    body: "We crawl your whole site from its sitemap and read the structured data already on every page.",
    numClass: "bg-valid/10 text-valid",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
        <line x1="10.5" y1="10.5" x2="14" y2="14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
    iconClass: "text-valid",
  },
  {
    num: 2,
    title: "Validate & Fix",
    body: "Deterministic gates judge every schema. AI generates or repairs whatever is missing or invalid — it never gets to grade its own work.",
    numClass: "bg-fix/10 text-fix-bright",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8.5 1L3 9.5H7.5L7 15L13 6.5H8.5L9 1H8.5Z" fill="currentColor" />
      </svg>
    ),
    iconClass: "text-fix-bright",
  },
  {
    num: 3,
    title: "Inject & Prove",
    body: "Fixes are staged into your Shopify theme with automatic rollback, then verified on the live page — proof you can check in Google's Rich Results Test.",
    numClass: "bg-valid/10 text-valid",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M2.5 8.5L6 12L13.5 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    iconClass: "text-valid",
  },
];

export default function HowItWorks() {
  return (
    <section className="mb-12">
      <h2 className="mb-3 pl-1 font-serif text-[11px] uppercase tracking-wider text-text-muted">
        How it works
      </h2>
      <div className="grid gap-3 sm:grid-cols-3">
        {STEPS.map((step) => (
          <div
            key={step.num}
            className="rounded-lg border border-border bg-surface-1 p-5"
          >
            <div className="mb-3 flex items-center gap-2.5">
              <div
                className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${step.numClass}`}
              >
                {step.num}
              </div>
              <span className={step.iconClass}>{step.icon}</span>
            </div>
            <h3 className="text-[13px] font-semibold text-text-primary">
              {step.title}
            </h3>
            <p className="mt-1.5 text-xs leading-relaxed text-text-secondary">
              {step.body}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
