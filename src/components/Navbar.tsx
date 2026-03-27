"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";
import { createBrowserClient } from "@/lib/supabase";

const navItems = [
  { href: "/", label: "Scan" },
  { href: "/editor", label: "Schemas" },
];

export default function Navbar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user } = useAuth();

  async function handleSignOut() {
    const supabase = createBrowserClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  // Hide navbar on login
  if (pathname === "/login") return null;

  return (
    <nav className="border-b border-border bg-surface-0">
      <div className="mx-auto flex h-12 max-w-6xl items-center justify-between px-5">
        <div className="flex items-center gap-6">
          <Link
            href="/"
            className="font-mono text-sm font-bold text-accent tracking-tight"
          >
            SchemaGen
          </Link>

          <div className="flex items-center gap-1">
            {navItems.map((item) => {
              const isActive =
                item.href === "/"
                  ? pathname === "/" || pathname === "/report"
                  : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rounded-sm px-2.5 py-1 text-xs font-medium transition-colors ${
                    isActive
                      ? "bg-surface-2 text-text-primary"
                      : "text-text-muted hover:text-text-secondary"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>

        {user && (
          <div className="flex items-center gap-3">
            <span className="max-w-[140px] truncate font-mono text-[10px] text-text-muted">
              {user.email}
            </span>
            <button
              onClick={handleSignOut}
              className="rounded-sm px-2 py-1 text-[10px] font-medium text-text-muted transition-colors hover:text-text-secondary"
            >
              Sign Out
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
