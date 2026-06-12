/**
 * The guarantees strip: why it's safe to let the agent touch a live theme.
 * One clean card in the homepage motif — no gradients, no blobs.
 */

const GUARANTEES = [
  {
    title: "Deterministic validation gates",
    body: "Every change must pass strict, code-level checks (built, valid, rich-eligible, no-regression, live-verified). The AI is never the quality gate.",
  },
  {
    title: "Staged writes with automatic rollback",
    body: "Your theme is backed up before anything is written. If live verification fails, we restore it byte-identical — automatically.",
  },
  {
    title: "Full audit trail",
    body: "Every action is recorded: the schema before, the schema after, each gate verdict, and the outcome. Nothing happens off the record.",
  },
  {
    title: "You stay in control",
    body: "Optionally review and tweak any AI-generated descriptions before or after they go live. Everything else just works.",
  },
];

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      className="shrink-0"
      aria-hidden="true"
    >
      <path
        d="M2.5 8.5L6 12L13.5 4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function TrustSection() {
  return (
    <section className="mb-12">
      <h2 className="mb-3 pl-1 font-serif text-[11px] uppercase tracking-wider text-text-muted">
        Built to be trusted with your live store
      </h2>
      <div className="overflow-hidden rounded-lg border border-border bg-surface-1">
        <div className="grid sm:grid-cols-2">
          {GUARANTEES.map((g, i) => (
            <div
              key={g.title}
              className={[
                "flex gap-3 px-5 py-4",
                // 2-col grid on sm+: top row keeps its bottom border, left column
                // gets a right border. On mobile every row but the last divides.
                i % 2 === 0 ? "sm:border-r sm:border-border" : "",
                i < 2 ? "border-b border-border" : "",
                i === 2 ? "border-b border-border sm:border-b-0" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <div className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-valid/10 text-valid">
                <CheckIcon />
              </div>
              <div>
                <h3 className="text-[13px] font-semibold text-text-primary">
                  {g.title}
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-text-secondary">
                  {g.body}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
