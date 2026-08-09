"use client";

import { Loader2 } from "lucide-react";

/**
 * A scrim over the app until the first desktop is up.
 *
 * The composer is disabled during boot, but a greyed field in the corner is a
 * detail the user has to go looking for. This states the wait plainly, in the
 * middle of the screen, and its disappearance is the signal that typing works.
 * It stays translucent so the layout underneath reads as the app loading rather
 * than a separate splash screen.
 *
 * First boot only — a session switch or a desktop refresh reuses the same
 * connect path, and veiling the screen for those would sit on top of a
 * transcript the user is still reading.
 */
export const BootOverlay = () => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-[2px]">
    <div className="flex items-center gap-3 rounded-xl border border-border bg-background/95 px-4 py-3 shadow-sm">
      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
      <div className="text-left">
        <p className="text-sm font-medium text-foreground">Starting your desktop…</p>
      </div>
    </div>
  </div>
);
