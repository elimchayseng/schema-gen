import type { SchemaTypeDefinition } from "./types";

/**
 * Complete schema.org type definitions — the single source of truth
 * for validation rules (PRD Section 8, Component 1).
 *
 * Inheritance: if a type has `extends`, its parent's properties are
 * merged at validation time. Child properties override parent properties
 * with the same name.
 *
 * `invalidProperties` maps property names that are commonly misplaced
 * onto this type to a correction message (PRD Appendix B).
 */
export const schemaDefinitions: Record<string, SchemaTypeDefinition> = {
  // ------------------------------------------------------------------
  // Base type — all others inherit from Thing
  // ------------------------------------------------------------------
  Thing: {
    type: "Thing",
    description: "The most generic type. All other types inherit from Thing.",
    properties: [
      {
        name: "name",
        requirement: "recommended",
        valueType: "Text",
        description: "The name of the item.",
      },
      {
        name: "description",
        requirement: "recommended",
        valueType: "Text",
        description: "A description of the item.",
      },
      {
        name: "url",
        requirement: "optional",
        valueType: "URL",
        description: "URL of the item.",
      },
      {
        name: "image",
        requirement: "optional",
        valueType: "URL",
        description: "An image of the item.",
      },
      {
        name: "sameAs",
        requirement: "optional",
        valueType: "Array",
        arrayItemType: "URL",
        description:
          "URL of a reference web page that unambiguously indicates the item's identity.",
      },
    ],
  },

  // ------------------------------------------------------------------
  // Core ecommerce types
  // ------------------------------------------------------------------
  Product: {
    type: "Product",
    extends: "Thing",
    description: "Any offered product or service.",
    properties: [
      {
        name: "name",
        requirement: "required",
        valueType: "Text",
        description: "The name of the product.",
      },
      {
        name: "description",
        requirement: "recommended",
        valueType: "Text",
      },
      {
        name: "image",
        requirement: "recommended",
        valueType: "URL",
      },
      {
        name: "sku",
        requirement: "recommended",
        valueType: "Text",
      },
      {
        name: "gtin",
        requirement: "optional",
        valueType: "Text",
        pattern: "^\\d{8,14}$",
        description: "Global Trade Item Number (8-14 digits).",
      },
      {
        name: "gtin8",
        requirement: "optional",
        valueType: "Text",
        pattern: "^\\d{8}$",
      },
      {
        name: "gtin12",
        requirement: "optional",
        valueType: "Text",
        pattern: "^\\d{12}$",
      },
      {
        name: "gtin13",
        requirement: "optional",
        valueType: "Text",
        pattern: "^\\d{13}$",
      },
      {
        name: "gtin14",
        requirement: "optional",
        valueType: "Text",
        pattern: "^\\d{14}$",
      },
      {
        name: "mpn",
        requirement: "optional",
        valueType: "Text",
      },
      {
        name: "brand",
        requirement: "recommended",
        valueType: "Object",
        expectedTypes: ["Brand"],
      },
      {
        name: "offers",
        requirement: "required",
        valueType: "Object",
        expectedTypes: ["Offer", "AggregateOffer"],
      },
      {
        name: "aggregateRating",
        requirement: "optional",
        valueType: "Object",
        expectedTypes: ["AggregateRating"],
      },
      {
        name: "review",
        requirement: "optional",
        valueType: "Array",
        arrayItemType: "Object",
        arrayItemExpectedTypes: ["Review"],
      },
      {
        name: "color",
        requirement: "optional",
        valueType: "Text",
      },
      {
        name: "material",
        requirement: "optional",
        valueType: "Text",
      },
      {
        name: "weight",
        requirement: "optional",
        valueType: "Object",
        expectedTypes: ["QuantitativeValue"],
      },
      {
        name: "url",
        requirement: "recommended",
        valueType: "URL",
      },
    ],
    invalidProperties: {
      openingHours: "'openingHours' belongs on LocalBusiness, not Product.",
      menu: "'menu' belongs on LocalBusiness/FoodEstablishment, not Product.",
      servesCuisine:
        "'servesCuisine' belongs on FoodEstablishment, not Product.",
    },
  },

  Offer: {
    type: "Offer",
    extends: "Thing",
    description: "An offer to transfer some rights to an item or to provide a service.",
    properties: [
      {
        name: "price",
        requirement: "required",
        valueType: "Number",
        description: "The offer price of the product.",
      },
      {
        name: "priceCurrency",
        requirement: "required",
        valueType: "Text",
        pattern: "^[A-Z]{3}$",
        description: "The currency of the price (ISO 4217, e.g. USD).",
      },
      {
        name: "availability",
        requirement: "recommended",
        valueType: "Enum",
        enumValues: [
          "https://schema.org/InStock",
          "https://schema.org/OutOfStock",
          "https://schema.org/PreOrder",
          "https://schema.org/SoldOut",
          "https://schema.org/BackOrder",
          "https://schema.org/Discontinued",
          "https://schema.org/OnlineOnly",
          "https://schema.org/LimitedAvailability",
          "https://schema.org/InStoreOnly",
        ],
      },
      {
        name: "itemCondition",
        requirement: "optional",
        valueType: "Enum",
        enumValues: [
          "https://schema.org/NewCondition",
          "https://schema.org/UsedCondition",
          "https://schema.org/RefurbishedCondition",
          "https://schema.org/DamagedCondition",
        ],
      },
      {
        name: "url",
        requirement: "recommended",
        valueType: "URL",
      },
      {
        name: "priceValidUntil",
        requirement: "optional",
        valueType: "Date",
      },
      {
        name: "seller",
        requirement: "optional",
        valueType: "Object",
        expectedTypes: ["Organization", "Person"],
      },
    ],
    invalidProperties: {
      color: "'color' is not valid on Offer. Move to Product.",
      material: "'material' is not valid on Offer. Move to Product.",
      brand: "'brand' is not valid on Offer. Move to Product.",
      sku: "'sku' is not valid on Offer. Move to Product.",
      gtin: "'gtin' is not valid on Offer. Move to Product.",
      weight: "'weight' is not valid on Offer. Move to Product.",
      review: "'review' is not valid on Offer. Move to Product.",
      aggregateRating:
        "'aggregateRating' is not valid on Offer. Move to Product.",
    },
  },

  // ------------------------------------------------------------------
  // Organization types
  // ------------------------------------------------------------------
  Organization: {
    type: "Organization",
    extends: "Thing",
    description: "An organization such as a school, NGO, corporation, club, etc.",
    properties: [
      {
        name: "name",
        requirement: "required",
        valueType: "Text",
      },
      {
        name: "url",
        requirement: "required",
        valueType: "URL",
      },
      {
        name: "logo",
        requirement: "recommended",
        valueType: "URL",
      },
      {
        name: "description",
        requirement: "recommended",
        valueType: "Text",
      },
      {
        name: "contactPoint",
        requirement: "optional",
        valueType: "Object",
        expectedTypes: ["ContactPoint"],
      },
      {
        name: "address",
        requirement: "optional",
        valueType: "Object",
        expectedTypes: ["PostalAddress"],
      },
      {
        name: "sameAs",
        requirement: "recommended",
        valueType: "Array",
        arrayItemType: "URL",
        description: "Social profile URLs.",
      },
      {
        name: "telephone",
        requirement: "optional",
        valueType: "Text",
      },
      {
        name: "email",
        requirement: "optional",
        valueType: "Text",
      },
      {
        name: "founder",
        requirement: "optional",
        valueType: "Object",
        expectedTypes: ["Person"],
      },
      {
        name: "foundingDate",
        requirement: "optional",
        valueType: "Date",
      },
    ],
  },

  LocalBusiness: {
    type: "LocalBusiness",
    extends: "Organization",
    description:
      "A particular physical business or branch of an organization.",
    properties: [
      {
        name: "address",
        requirement: "required",
        valueType: "Object",
        expectedTypes: ["PostalAddress"],
      },
      {
        name: "telephone",
        requirement: "recommended",
        valueType: "Text",
      },
      {
        name: "openingHoursSpecification",
        requirement: "recommended",
        valueType: "Array",
        arrayItemType: "Object",
        arrayItemExpectedTypes: ["OpeningHoursSpecification"],
      },
      {
        name: "geo",
        requirement: "optional",
        valueType: "Object",
        expectedTypes: ["GeoCoordinates"],
      },
      {
        name: "priceRange",
        requirement: "optional",
        valueType: "Text",
      },
      {
        name: "servesCuisine",
        requirement: "optional",
        valueType: "Text",
      },
      {
        name: "menu",
        requirement: "optional",
        valueType: "URL",
      },
      {
        name: "image",
        requirement: "recommended",
        valueType: "URL",
      },
    ],
  },

  // ------------------------------------------------------------------
  // FAQ types
  // ------------------------------------------------------------------
  FAQPage: {
    type: "FAQPage",
    extends: "Thing",
    description: "A page with frequently asked questions and answers.",
    properties: [
      {
        name: "mainEntity",
        requirement: "required",
        valueType: "Array",
        arrayItemType: "Object",
        arrayItemExpectedTypes: ["Question"],
        description: "An array of Question objects.",
      },
    ],
    invalidProperties: {
      offers: "'offers' is not valid on FAQPage.",
      price: "'price' is not valid on FAQPage.",
      brand: "'brand' is not valid on FAQPage.",
    },
  },

  Question: {
    type: "Question",
    extends: "Thing",
    description: "A specific question.",
    properties: [
      {
        name: "name",
        requirement: "required",
        valueType: "Text",
        description: "The full text of the question.",
      },
      {
        name: "acceptedAnswer",
        requirement: "required",
        valueType: "Object",
        expectedTypes: ["Answer"],
      },
    ],
  },

  Answer: {
    type: "Answer",
    extends: "Thing",
    description: "An answer to a question.",
    properties: [
      {
        name: "text",
        requirement: "required",
        valueType: "Text",
        description: "The full text of the answer.",
      },
    ],
  },

  // ------------------------------------------------------------------
  // Content types
  // ------------------------------------------------------------------
  Article: {
    type: "Article",
    extends: "Thing",
    description: "An article, such as a news article or blog post.",
    properties: [
      {
        name: "headline",
        requirement: "required",
        valueType: "Text",
      },
      {
        name: "author",
        requirement: "required",
        valueType: "Object",
        expectedTypes: ["Person", "Organization"],
      },
      {
        name: "datePublished",
        requirement: "required",
        valueType: "DateTime",
      },
      {
        name: "dateModified",
        requirement: "recommended",
        valueType: "DateTime",
      },
      {
        name: "image",
        requirement: "recommended",
        valueType: "URL",
      },
      {
        name: "publisher",
        requirement: "recommended",
        valueType: "Object",
        expectedTypes: ["Organization"],
      },
      {
        name: "articleBody",
        requirement: "optional",
        valueType: "Text",
      },
      {
        name: "wordCount",
        requirement: "optional",
        valueType: "Integer",
      },
    ],
  },

  BlogPosting: {
    type: "BlogPosting",
    extends: "Article",
    description: "A blog post.",
    properties: [],
  },

  // ------------------------------------------------------------------
  // Navigation types
  // ------------------------------------------------------------------
  BreadcrumbList: {
    type: "BreadcrumbList",
    extends: "Thing",
    description: "A set of links representing a breadcrumb trail.",
    properties: [
      {
        name: "itemListElement",
        requirement: "required",
        valueType: "Array",
        arrayItemType: "Object",
        arrayItemExpectedTypes: ["ListItem"],
      },
    ],
    invalidProperties: {
      offers: "'offers' is not valid on BreadcrumbList.",
      price: "'price' is not valid on BreadcrumbList.",
    },
  },

  ListItem: {
    type: "ListItem",
    extends: "Thing",
    description: "An item in a list (e.g. breadcrumb trail).",
    properties: [
      {
        name: "position",
        requirement: "required",
        valueType: "Integer",
      },
      {
        name: "name",
        requirement: "required",
        valueType: "Text",
      },
      {
        name: "item",
        requirement: "required",
        valueType: "URL",
        description: "The URL this breadcrumb links to.",
      },
    ],
  },

  // ------------------------------------------------------------------
  // Rating & Review types
  // ------------------------------------------------------------------
  AggregateRating: {
    type: "AggregateRating",
    extends: "Thing",
    description: "The average rating based on multiple ratings or reviews.",
    properties: [
      {
        name: "ratingValue",
        requirement: "required",
        valueType: "Number",
      },
      {
        name: "reviewCount",
        requirement: "recommended",
        valueType: "Integer",
      },
      {
        name: "ratingCount",
        requirement: "optional",
        valueType: "Integer",
      },
      {
        name: "bestRating",
        requirement: "optional",
        valueType: "Number",
      },
      {
        name: "worstRating",
        requirement: "optional",
        valueType: "Number",
      },
    ],
  },

  Review: {
    type: "Review",
    extends: "Thing",
    description: "A review of an item.",
    properties: [
      {
        name: "author",
        requirement: "required",
        valueType: "Object",
        expectedTypes: ["Person", "Organization"],
      },
      {
        name: "reviewRating",
        requirement: "required",
        valueType: "Object",
        expectedTypes: ["Rating"],
      },
      {
        name: "reviewBody",
        requirement: "optional",
        valueType: "Text",
      },
      {
        name: "datePublished",
        requirement: "optional",
        valueType: "DateTime",
      },
    ],
  },

  Rating: {
    type: "Rating",
    extends: "Thing",
    description: "An individual rating.",
    properties: [
      {
        name: "ratingValue",
        requirement: "required",
        valueType: "Number",
      },
      {
        name: "bestRating",
        requirement: "optional",
        valueType: "Number",
      },
      {
        name: "worstRating",
        requirement: "optional",
        valueType: "Number",
      },
    ],
  },

  // ------------------------------------------------------------------
  // Address & location types
  // ------------------------------------------------------------------
  PostalAddress: {
    type: "PostalAddress",
    extends: "Thing",
    description: "A mailing address.",
    properties: [
      {
        name: "streetAddress",
        requirement: "required",
        valueType: "Text",
      },
      {
        name: "addressLocality",
        requirement: "required",
        valueType: "Text",
      },
      {
        name: "addressRegion",
        requirement: "recommended",
        valueType: "Text",
      },
      {
        name: "postalCode",
        requirement: "recommended",
        valueType: "Text",
      },
      {
        name: "addressCountry",
        requirement: "recommended",
        valueType: "Text",
      },
    ],
  },

  GeoCoordinates: {
    type: "GeoCoordinates",
    extends: "Thing",
    description: "Geographic coordinates.",
    properties: [
      {
        name: "latitude",
        requirement: "required",
        valueType: "Number",
      },
      {
        name: "longitude",
        requirement: "required",
        valueType: "Number",
      },
    ],
  },

  // ------------------------------------------------------------------
  // Brand
  // ------------------------------------------------------------------
  Brand: {
    type: "Brand",
    extends: "Thing",
    description: "A brand.",
    properties: [
      {
        name: "name",
        requirement: "required",
        valueType: "Text",
      },
      {
        name: "logo",
        requirement: "optional",
        valueType: "URL",
      },
      {
        name: "url",
        requirement: "optional",
        valueType: "URL",
      },
    ],
  },

  // ------------------------------------------------------------------
  // Person
  // ------------------------------------------------------------------
  Person: {
    type: "Person",
    extends: "Thing",
    description: "A person.",
    properties: [
      {
        name: "name",
        requirement: "required",
        valueType: "Text",
      },
      {
        name: "url",
        requirement: "optional",
        valueType: "URL",
      },
      {
        name: "jobTitle",
        requirement: "optional",
        valueType: "Text",
      },
    ],
  },

  // ------------------------------------------------------------------
  // WebSite & SearchAction
  // ------------------------------------------------------------------
  WebSite: {
    type: "WebSite",
    extends: "Thing",
    description: "A website.",
    properties: [
      {
        name: "name",
        requirement: "required",
        valueType: "Text",
      },
      {
        name: "url",
        requirement: "required",
        valueType: "URL",
      },
      {
        name: "potentialAction",
        requirement: "optional",
        valueType: "Object",
        expectedTypes: ["SearchAction"],
      },
    ],
  },

  SearchAction: {
    type: "SearchAction",
    extends: "Thing",
    description: "The act of searching.",
    properties: [
      {
        name: "target",
        requirement: "required",
        valueType: "Text",
        description: "URL template with {search_term_string} placeholder.",
      },
      {
        name: "query-input",
        requirement: "required",
        valueType: "Text",
      },
    ],
  },

  // ------------------------------------------------------------------
  // Contact & Opening Hours (nested utility types)
  // ------------------------------------------------------------------
  ContactPoint: {
    type: "ContactPoint",
    extends: "Thing",
    description: "A contact point.",
    properties: [
      {
        name: "telephone",
        requirement: "required",
        valueType: "Text",
      },
      {
        name: "contactType",
        requirement: "required",
        valueType: "Text",
        description: "E.g. 'customer service', 'sales'.",
      },
      {
        name: "email",
        requirement: "optional",
        valueType: "Text",
      },
      {
        name: "areaServed",
        requirement: "optional",
        valueType: "Text",
      },
      {
        name: "availableLanguage",
        requirement: "optional",
        valueType: "Text",
      },
    ],
  },

  OpeningHoursSpecification: {
    type: "OpeningHoursSpecification",
    extends: "Thing",
    description: "Structured opening hours for a location.",
    properties: [
      {
        name: "dayOfWeek",
        requirement: "required",
        valueType: "Enum",
        enumValues: [
          "https://schema.org/Monday",
          "https://schema.org/Tuesday",
          "https://schema.org/Wednesday",
          "https://schema.org/Thursday",
          "https://schema.org/Friday",
          "https://schema.org/Saturday",
          "https://schema.org/Sunday",
        ],
      },
      {
        name: "opens",
        requirement: "required",
        valueType: "Time",
      },
      {
        name: "closes",
        requirement: "required",
        valueType: "Time",
      },
    ],
  },

  QuantitativeValue: {
    type: "QuantitativeValue",
    extends: "Thing",
    description: "A point value or interval for product characteristics.",
    properties: [
      {
        name: "value",
        requirement: "required",
        valueType: "Number",
      },
      {
        name: "unitCode",
        requirement: "recommended",
        valueType: "Text",
        description: "UN/CEFACT unit code (e.g. 'KGM' for kilograms).",
      },
      {
        name: "unitText",
        requirement: "optional",
        valueType: "Text",
        description: "Human-readable unit (e.g. 'kg').",
      },
    ],
  },

  // ------------------------------------------------------------------
  // HowTo types (Google Rich Result eligible)
  // ------------------------------------------------------------------
  HowTo: {
    type: "HowTo",
    extends: "Thing",
    description: "Instructions for how to achieve a result by performing a sequence of steps.",
    properties: [
      {
        name: "name",
        requirement: "required",
        valueType: "Text",
        description: "The title of the how-to.",
      },
      {
        name: "step",
        requirement: "required",
        valueType: "Array",
        arrayItemType: "Object",
        arrayItemExpectedTypes: ["HowToStep", "HowToSection"],
        description: "The steps to complete the how-to.",
      },
      {
        name: "description",
        requirement: "recommended",
        valueType: "Text",
      },
      {
        name: "totalTime",
        requirement: "recommended",
        valueType: "Text",
        description: "Total time to perform all steps (ISO 8601 duration, e.g. PT30M).",
      },
      {
        name: "estimatedCost",
        requirement: "optional",
        valueType: "Text",
        description: "Estimated cost of supplies consumed.",
      },
      {
        name: "supply",
        requirement: "optional",
        valueType: "Array",
        arrayItemType: "Text",
        description: "Supplies consumed when performing instructions.",
      },
      {
        name: "tool",
        requirement: "optional",
        valueType: "Array",
        arrayItemType: "Text",
        description: "Tools used but not consumed.",
      },
    ],
  },

  HowToStep: {
    type: "HowToStep",
    extends: "Thing",
    description: "A single step in a how-to.",
    properties: [
      {
        name: "text",
        requirement: "required",
        valueType: "Text",
        description: "The full instruction text of this step.",
      },
      {
        name: "name",
        requirement: "recommended",
        valueType: "Text",
        description: "A short summary of the step.",
      },
      {
        name: "url",
        requirement: "optional",
        valueType: "URL",
        description: "URL that directly links to this step.",
      },
      {
        name: "image",
        requirement: "optional",
        valueType: "URL",
        description: "Image illustrating this step.",
      },
    ],
  },

  HowToSection: {
    type: "HowToSection",
    extends: "Thing",
    description: "A grouping of steps within a how-to.",
    properties: [
      {
        name: "name",
        requirement: "recommended",
        valueType: "Text",
        description: "The name of this section.",
      },
      {
        name: "itemListElement",
        requirement: "required",
        valueType: "Array",
        arrayItemType: "Object",
        arrayItemExpectedTypes: ["HowToStep"],
        description: "The steps in this section.",
      },
    ],
  },

  HowToDirection: {
    type: "HowToDirection",
    extends: "Thing",
    description: "A direction in the instructions for a how-to.",
    properties: [
      {
        name: "text",
        requirement: "required",
        valueType: "Text",
        description: "The direction text.",
      },
    ],
  },

  HowToTip: {
    type: "HowToTip",
    extends: "Thing",
    description: "A tip for completing a step in a how-to.",
    properties: [
      {
        name: "text",
        requirement: "required",
        valueType: "Text",
        description: "The tip text.",
      },
    ],
  },

  // ------------------------------------------------------------------
  // Page types
  // ------------------------------------------------------------------
  CollectionPage: {
    type: "CollectionPage",
    extends: "Thing",
    description: "A page that groups related items (e.g. a product collection).",
    properties: [
      {
        name: "name",
        requirement: "recommended",
        valueType: "Text",
      },
      {
        name: "description",
        requirement: "recommended",
        valueType: "Text",
      },
      {
        name: "url",
        requirement: "recommended",
        valueType: "URL",
      },
      {
        name: "mainEntity",
        requirement: "optional",
        valueType: "Object",
        expectedTypes: ["ItemList"],
        description: "The primary list of items on this page.",
      },
    ],
  },

  ItemList: {
    type: "ItemList",
    extends: "Thing",
    description: "A list of items, often used for carousels or collections.",
    properties: [
      {
        name: "itemListElement",
        requirement: "required",
        valueType: "Array",
        arrayItemType: "Object",
        arrayItemExpectedTypes: ["ListItem"],
        description: "The items in this list.",
      },
      {
        name: "name",
        requirement: "recommended",
        valueType: "Text",
      },
      {
        name: "numberOfItems",
        requirement: "recommended",
        valueType: "Integer",
      },
      {
        name: "itemListOrder",
        requirement: "optional",
        valueType: "Text",
        description: "The order of the list (e.g. 'ascending', 'descending', 'unordered').",
      },
    ],
  },

  AboutPage: {
    type: "AboutPage",
    extends: "Thing",
    description: "A web page that provides information about the site or organization.",
    properties: [
      {
        name: "name",
        requirement: "recommended",
        valueType: "Text",
      },
      {
        name: "description",
        requirement: "recommended",
        valueType: "Text",
      },
      {
        name: "url",
        requirement: "recommended",
        valueType: "URL",
      },
    ],
  },

  ContactPage: {
    type: "ContactPage",
    extends: "Thing",
    description: "A web page with contact information.",
    properties: [
      {
        name: "name",
        requirement: "recommended",
        valueType: "Text",
      },
      {
        name: "description",
        requirement: "recommended",
        valueType: "Text",
      },
      {
        name: "url",
        requirement: "recommended",
        valueType: "URL",
      },
    ],
  },
};
