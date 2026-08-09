"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * A breakpoint read in JavaScript rather than in CSS.
 *
 * Almost everything responsive here is a Tailwind class, and should stay that
 * way. This exists for the one thing classes cannot express: something that
 * must be **mounted once**, in a different place at each breakpoint. Hiding a
 * second copy with `hidden` still mounts it, and for the VNC iframe that means
 * a second client connected to the same desktop.
 *
 * The server has no viewport, so it always answers `false`; a wide client
 * corrects that on hydration.
 */
export const useMediaQuery = (query: string): boolean => {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
};
