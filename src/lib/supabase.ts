import {
  createBrowserClient as _createBrowserClient,
  createServerClient as _createServerClient,
} from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import type { CookieOptions } from "@supabase/ssr";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * Browser client — use in Client Components ("use client").
 * Handles cookie-based session automatically via @supabase/ssr.
 */
export function createBrowserClient() {
  return _createBrowserClient(supabaseUrl, supabaseAnonKey);
}

/**
 * Server client — use in Server Components, Route Handlers, and middleware.
 * Requires a cookieStore from next/headers (or request/response objects in middleware).
 */
export function createServerClient(cookieStore: {
  getAll(): { name: string; value: string }[];
  set(name: string, value: string, options: CookieOptions): void;
}) {
  return _createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) =>
          cookieStore.set(name, value, options)
        );
      },
    },
  });
}

/**
 * Admin client — server-only, bypasses RLS.
 * Only use in trusted server-side contexts (e.g. profile creation triggers).
 * Never import this in Client Components.
 */
export function createAdminClient() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
