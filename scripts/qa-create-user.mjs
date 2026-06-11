import { createClient } from "@supabase/supabase-js";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const email = "qa-e2e@schemagen.test";
const password = "qa-e2e-password-123";
const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (error) {
  if (String(error.message).toLowerCase().includes("already")) console.log("user exists:", email);
  else { console.error("ERROR:", error.message); process.exit(1); }
} else console.log("created:", data.user.id, email);
