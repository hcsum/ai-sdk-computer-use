"use client";

import { ChevronDown, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/** How much of the viewport an open section takes. */
const OPEN_HEIGHT = "h-[52dvh]";

/**
 * An open section is a different surface from the chat, not a continuation of
 * it. `--muted` cannot say that — it sits 3% off `--background` in light mode,
 * so the seam against the last message all but disappears.
 *
 * Raw zinc rather than a semantic token because the palette has none for a
 * recessed surface: every neutral it defines sits within a few percent of
 * `--background`. Each mode moves away from the page in its own direction —
 * light goes down to zinc-200, dark goes past the background to black — so the
 * cards inside, which stay `bg-background`, read as raised in both.
 */
const OPEN_SURFACE = "bg-zinc-200/80 dark:bg-black";

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
        "relative z-10 flex shrink-0 flex-col overflow-hidden border-t border-border bg-muted/40",
        // Fixed rather than capped, so a section occupies the same space no
        // matter what is inside it — a height that tracks its contents moves
        // the composer under the user's cursor.
        isOpen && [OPEN_HEIGHT, OPEN_SURFACE],
      )}
    >
      <DockBar {...bar}>{barContent}</DockBar>
      {isOpen || keepMounted ? (
        <div
          className={cn(
            "min-h-0 overflow-hidden",
            // A collapsed `keepMounted` body is a zero-height box whose contents
            // still have layout: the desktop's "New desktop" button is absolute
            // and sits 44px below the box, and the VNC iframe is a cross-process
            // compositing layer. Height alone leaves both of those to the
            // ancestor's clip, and a live iframe's layer does not always get
            // re-clipped when only the container's height changes — which is the
            // stream bleeding over the bar below it until something forces a
            // repaint. `invisible` takes it out of painting altogether, and
            // unlike unmounting or `display: none` it does not drop the
            // connection.
            isOpen ? "flex-1" : "h-0 invisible pointer-events-none",
            bodyClassName,
          )}
          aria-hidden={!isOpen}
        >
          {children}
        </div>
      ) : null}
    </aside>
  );
}
