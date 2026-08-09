"use client";

import { ChevronDown, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/** How much of the viewport an open section takes. */
const OPEN_HEIGHT = "h-[45dvh]";

type DockBarProps = {
  icon: LucideIcon;
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  /** Status, counts, whatever this section wants to say while collapsed. */
  children?: React.ReactNode;
};

/**
 * The bar every docked section wears.
 *
 * Below `xl` the desktop, the event log and the inspector are peers competing
 * for the same strip of screen, and only one of them is open at a time. That
 * rule is only legible if they are visibly the same kind of thing, which is why
 * the bar is a shared component rather than three that happen to match.
 */
export function DockBar({ icon: Icon, title, isOpen, onToggle, children }: DockBarProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isOpen}
      className="flex shrink-0 items-center gap-2 px-4 py-2.5 text-left"
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-sm font-semibold text-foreground">{title}</span>
      {children}
      <ChevronDown
        className={cn(
          "ml-auto size-4 shrink-0 text-muted-foreground transition-transform",
          !isOpen && "rotate-180",
        )}
      />
    </button>
  );
}

type DockSectionProps = Omit<DockBarProps, "children"> & {
  /** Rendered in the bar, between the title and the chevron. */
  barContent?: React.ReactNode;
  /**
   * Keep the body in the tree while collapsed, at zero height. The desktop
   * needs this — its iframe holds a live VNC connection that a remount would
   * drop — and nothing else should pay for it.
   */
  keepMounted?: boolean;
  bodyClassName?: string;
};

export function DockSection({
  keepMounted = false,
  bodyClassName,
  barContent,
  children,
  ...bar
}: DockSectionProps & { children?: React.ReactNode }) {
  const { isOpen } = bar;

  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col overflow-hidden border-t border-border bg-muted/40",
        // Fixed rather than capped, so a section occupies the same space no
        // matter what is inside it — a height that tracks its contents moves
        // the composer under the user's cursor.
        isOpen && OPEN_HEIGHT,
      )}
    >
      <DockBar {...bar}>{barContent}</DockBar>
      {isOpen || keepMounted ? (
        <div
          className={cn("min-h-0", isOpen ? "flex-1" : "h-0", bodyClassName)}
          aria-hidden={!isOpen}
        >
          {children}
        </div>
      ) : null}
    </aside>
  );
}
