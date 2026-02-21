// Bare layout for auth pages — no Navbar, no max-width container.
// The login page handles its own full-screen centering.
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
