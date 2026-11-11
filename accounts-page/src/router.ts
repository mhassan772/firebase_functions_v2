/// Which page a path shows, kept apart from the DOM so it can be tested.

export type Route = "action" | "delete" | "notFound";

const ROUTES: Readonly<Record<string, Route>> = {
  "/action": "action",
  "/delete": "delete",
};

/// Matches the paths Hosting rewrites to this page; a trailing slash is tolerated, case is not.
export function routeFor(pathname: string): Route {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return ROUTES[trimmed] ?? "notFound";
}
