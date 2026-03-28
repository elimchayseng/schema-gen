# SchemaGen

AI-powered schema.org structured data optimizer for ecommerce websites. Paste a URL, get validated, deployment-ready JSON-LD in seconds.

## Why structured data matters

Structured data has always driven rich results in Google. But now it's bigger than SEO.

AI tools like ChatGPT, Perplexity, and Google AI Overviews are pulling answers from the web and deciding which sources to cite. Pages with clean, complete structured data are easier for these systems to parse, trust, and reference. This is **Generative Engine Optimization (GEO)** ... making your content legible to LLMs, not just search crawlers.

- **Search:** Rich results (stars, price, availability, FAQs) still drive higher click-through rates
- **AI answers:** LLMs use structured data as a strong signal when deciding what information is reliable and worth citing
- **AI shopping:** Product schema with accurate pricing, availability, and reviews is how your products show up in AI-powered shopping experiences
- **Voice and assistants:** Alexa, Siri, and Google Assistant pull directly from JSON-LD to answer questions about businesses, products, and events

If your structured data is broken or missing, you're invisible to the next generation of discovery. Not just Google, but every AI system that reads the web.

## The problem

Most ecommerce sites have broken, incomplete, or missing structured data. Fixing it manually means reading the schema.org spec, debugging JSON-LD by hand, and hoping you got it right. Multiply that across hundreds of product pages and it becomes a project nobody finishes.

## What SchemaGen does

1. **Scan** any page and extract existing JSON-LD
2. **Validate** against schema.org rules and auto-fix common errors
3. **Generate** new schemas using AI based on actual page content
4. **Edit** schemas with real-time validation
6. **Deploy** copy-paste-ready JSON-LD scripts

## Key features

- **30+ schema types** validated: Product, Article, FAQPage, LocalBusiness, BreadcrumbList, Event, Review, and more
- **Auto-fixer** corrects misplaced properties, bad enum formats, missing @context, and other common mistakes
- **AI refinement loop** generates schemas, validates them, refines, and validates again with a regression guard that rejects changes that make things worse
- **Live editor** with inline validation errors and warnings

## Built with

- Next.js 15, React 19, TypeScript
- Tailwind CSS
- Supabase (auth + database)
- OpenAI-compatible LLM inference
