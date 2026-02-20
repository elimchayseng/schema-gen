/**
 * Server-only Supabase helpers.
 * Import from this file in Server Components and Route Handlers
 * to avoid accidentally pulling next/headers into Client Components.
 */
import { cookies } from "next/headers";
import { createServerClient } from "./supabase";

/**
 * Creates a server-side Supabase client bound to the current request's cookies.
 * Must only be called in Server Components or Route Handlers.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  return createServerClient({
    getAll() {
      return cookieStore.getAll();
    },
    set(name, value, options) {
      try {
        cookieStore.set({ name, value, ...options });
      } catch {
        // In Server Components, set() throws if called after response headers are sent.
        // This is safe to ignore — the session refresh will be handled by middleware.
      }
    },
  });
}
