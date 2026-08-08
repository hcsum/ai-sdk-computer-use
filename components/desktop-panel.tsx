"use client";

import { memo } from "react";

import { Button } from "@/components/ui/button";

type DesktopPanelProps = {
  streamUrl: string | null;
  isInitializing: boolean;
  onRefresh: () => void;
};

/**
 * The VNC stream, deliberately subscribed to nothing.
 *
 * Every prop here changes only when the desktop itself changes, so a streamed
 * token cannot reach this component and remount the iframe — which would drop
 * the VNC connection mid-run. `memo` is necessary but not sufficient: it is
 * defeated by any context whose value changes per token, so this must also stay
 * off the chat state's ancestor chain. See docs/event-model.md.
 */
export const DesktopPanel = memo(function DesktopPanel({
  streamUrl,
  isInitializing,
  onRefresh,
}: DesktopPanelProps) {
  if (!streamUrl) {
    return (
      <div className="flex items-center justify-center h-full text-white">
        {isInitializing ? "Initializing desktop..." : "Loading stream..."}
      </div>
    );
  }

  return (
    <>
      <iframe
        src={streamUrl}
        className="w-full h-full"
        style={{ transformOrigin: "center", width: "100%", height: "100%" }}
        allow="autoplay"
      />
      <Button
        onClick={onRefresh}
        className="absolute top-2 right-2 bg-black/50 hover:bg-black/70 text-white px-3 py-1 rounded text-sm z-10"
        disabled={isInitializing}
      >
        {isInitializing ? "Creating desktop..." : "New desktop"}
      </Button>
    </>
  );
});
