import * as cheerio from "cheerio";
import type { MissingOpportunity } from "./types";

export function detectMissingOpportunities(
  html: string,
  url: string,
  foundSchemaTypes: string[]
): MissingOpportunity[] {
  const found = new Set(foundSchemaTypes);
  const opportunities: MissingOpportunity[] = [];
  const $ = cheerio.load(html);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return [];
  }

  const pathname = parsedUrl.pathname;
  const pathParts = pathname.split("/").filter(Boolean);
  const isHomepage = pathParts.length === 0;

  // BreadcrumbList — suggest for any page more than 1 level deep
  if (!found.has("BreadcrumbList") && pathParts.length > 1) {
    opportunities.push({
      schemaType: "BreadcrumbList",
      reason: "This page has a multi-level URL path but no BreadcrumbList schema",
      confidence: "high",
    });
  }

  // WebSite — only on the homepage
  if (!found.has("WebSite") && isHomepage) {
    opportunities.push({
      schemaType: "WebSite",
      reason: "Homepage is a good place to add WebSite schema with a Sitelinks SearchBox",
      confidence: "high",
    });
  }

  // FAQPage — FAQ-like content signals
  if (!found.has("FAQPage")) {
    const hasFaqUrl =
      /\/(faq|faqs|help|questions|support)/i.test(pathname);
    const hasDetails = $("details").length > 0;
    const hasSummary = $("summary").length > 0;

    if (hasFaqUrl || (hasDetails && hasSummary)) {
      opportunities.push({
        schemaType: "FAQPage",
        reason: hasFaqUrl
          ? "Page URL suggests FAQ content"
          : "Page contains collapsible Q&A-like content (<details>/<summary>)",
        confidence: hasFaqUrl && (hasDetails || hasSummary) ? "high" : "medium",
      });
    }
  }

  // Product — product page signals
  if (!found.has("Product")) {
    const hasProductUrl = /\/(products|product|shop|item|p)\//i.test(pathname);
    const hasOgProduct =
      $('meta[property="og:type"][content="product"]').length > 0;
    const pricePattern = /\$[\d,]+\.?\d{0,2}|\d+\.\d{2}\s*(USD|EUR|GBP)/;
    const bodyText = $("body").text();
    const hasPriceText = pricePattern.test(bodyText);

    if (hasOgProduct || hasProductUrl) {
      opportunities.push({
        schemaType: "Product",
        reason: hasOgProduct
          ? "Page has Open Graph type 'product' but no Product schema"
          : "Page URL suggests a product page",
        confidence: hasOgProduct && hasPriceText ? "high" : "medium",
      });
    } else if (hasPriceText) {
      opportunities.push({
        schemaType: "Product",
        reason: "Page contains price-like text that may benefit from Product schema",
        confidence: "low",
      });
    }
  }

  // Article / BlogPosting — article content signals
  if (!found.has("Article") && !found.has("BlogPosting")) {
    const hasBlogUrl = /\/(blog|news|post|posts|article|articles)\//i.test(pathname);
    const hasArticleTag = $("article").length > 0;
    const hasTimeTag = $("time[datetime]").length > 0;
    const hasAuthorMeta = $('meta[name="author"]').length > 0;

    const signals = [hasBlogUrl, hasArticleTag, hasTimeTag, hasAuthorMeta].filter(Boolean).length;

    if (signals >= 2) {
      opportunities.push({
        schemaType: "Article",
        reason: "Page has article-like signals (article tag, publish date, author) but no Article schema",
        confidence: signals >= 3 ? "high" : "medium",
      });
    }
  }

  // LocalBusiness — local business signals (only on root or /contact)
  if (!found.has("LocalBusiness") && !found.has("Organization")) {
    const isContactPage = /\/(contact|about|location)/i.test(pathname);
    const bodyText = $("body").text();
    const hasPhone = /\+?[\d\s\-().]{10,}/.test(bodyText);
    const hasAddress =
      $('[class*="address"], [itemtype*="PostalAddress"]').length > 0 ||
      /\b\d{5}(-\d{4})?\b/.test(bodyText); // zip code pattern

    if ((isHomepage || isContactPage) && hasPhone && hasAddress) {
      opportunities.push({
        schemaType: "LocalBusiness",
        reason: "Page appears to belong to a local business (phone number + address found) but has no LocalBusiness schema",
        confidence: "medium",
      });
    }
  }

  return opportunities;
}
