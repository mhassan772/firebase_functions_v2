/// Which page a path shows, kept apart from the DOM so it can be tested.

export type Route = "action" | "delete" | "account" | "terms" | "notFound";

const ROUTES: Readonly<Record<string, Route>> = {
  "/action": "action",
  "/delete": "delete",
  // Both addresses of the account page, so older links and the billing emails keep working.
  "/subscribe": "account",
  "/manage": "account",
  "/terms": "terms",
};

/// Matches the paths Hosting rewrites to this page; a trailing slash is tolerated, case is not.
export function routeFor(pathname: string): Route {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return ROUTES[trimmed] ?? "notFound";
}
