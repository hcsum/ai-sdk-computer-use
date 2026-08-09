"use client";

import { Monitor } from "lucide-react";

import { DockSection } from "@/components/dock-section";
import { cn } from "@/lib/utils";

type DesktopDockProps = {
  isOpen: boolean;
  onToggle: () => void;
  isInitializing: boolean;
  isConnected: boolean;
  children: React.ReactNode;
};

/**
 * The desktop, docked under the chat below `xl`, where there is no room for a
 * second column.
 *
 * `keepMounted` is the whole reason this is not three lines inline: the VNC
 * iframe holds a live connection, so collapsing the section has to be a height
 * change and never a remount. The single-instance rule enforced by
 * `useMediaQuery` in `app/page.tsx` exists for the same reason.
 */
export function DesktopDock({
  isOpen,
  onToggle,
  isInitializing,
  isConnected,
  children,
}: DesktopDockProps) {
  const state = isInitializing
    ? { label: "connecting", dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" }
    : isConnected
      ? { label: "connected", dot: "bg-green-500", text: "text-green-600 dark:text-green-400" }
      : { label: "offline", dot: "bg-muted-foreground", text: "text-muted-foreground" };

  return (
    <DockSection
      icon={Monitor}
      title="Desktop"
      isOpen={isOpen}
      onToggle={onToggle}
      keepMounted
      bodyClassName="relative bg-black"
      barContent={
        <>
          <span className={cn("size-1.5 shrink-0 rounded-full", state.dot)} />
          <span className={cn("text-xs font-medium", state.text)}>{state.label}</span>
        </>
      }
    >
      {children}
    </DockSection>
  );
}
