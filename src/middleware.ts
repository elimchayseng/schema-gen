import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // Write cookies to the request (for downstream server components)
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          // Re-create the response so the updated cookies are in the headers
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANT: Do not add any logic between createServerClient and getUser().
  // A mistake here could make auth tokens stale and log users out.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // Redirect logged-in users away from the login page
  if (user && pathname === "/login") {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  // Redirect unauthenticated users to login for all protected routes.
  // /auth/callback must be excluded — it's the magic link landing route that
  // exchanges the one-time code for a session before the user is "logged in".
  if (!user && pathname !== "/login" && !pathname.startsWith("/auth/")) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // IMPORTANT: Return supabaseResponse (not a plain NextResponse.next()) so
  // the refreshed session cookie is included in the response headers.
  return supabaseResponse;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except Next.js internals and static files.
     * API routes are intentionally included so unauthenticated API calls
     * redirect to /login rather than returning a partial response.
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
