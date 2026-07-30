/**
 * A 30-line hash router. The point of the proof is the CMS surface, not
 * routing — but "bring your own router" has to be literally true.
 */
import { useEffect, useState } from "react";

export type Route =
  | { readonly name: "posts" }
  | { readonly name: "post"; readonly id: string }
  | { readonly name: "media" };

function parse(hash: string): Route {
  const path = hash.replace(/^#/, "");
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments[0] === "media") return { name: "media" };
  if (segments[0] === "posts" && segments[1] !== undefined) {
    return { name: "post", id: segments[1] };
  }
  return { name: "posts" };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function navigate(to: string): void {
  window.location.hash = to;
}
