import type { ValidationIssue } from "./validation/types";

export interface Profile {
  id: string;
  email: string | null;
  full_name: string | null;
  is_anonymous: boolean;
  created_at: string;
  updated_at: string;
}

export interface Schema {
  id: string;
  user_id: string;
  name: string;
  schema_type: string;
  content: Record<string, unknown>;
  source_url: string | null;
  validation_errors: ValidationIssue[] | null;
  missing_opportunities: MissingOpportunityRecord[] | null;
  created_at: string;
  updated_at: string;
}

export interface MissingOpportunityRecord {
  schemaType: string;
  reason: string;
  confidence: "high" | "medium" | "low";
}
