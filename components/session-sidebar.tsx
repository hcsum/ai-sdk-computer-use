"use client";

import { useState } from "react";
import { MessageSquarePlus, PanelLeftClose, PanelLeftOpen, Trash2 } from "lucide-react";

import type { SessionMeta } from "@/lib/session-store";
import { cn } from "@/lib/utils";

type SessionSidebarProps = {
  sessions: SessionMeta[];
  activeSessionId: string | null;
  onCreate: () => void;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  /**
   * Collapsed still shows the sessions, as initials, and still creates one.
   * The rail is part of the chat column rather than a panel of its own, so
   * collapsing it is meant to buy back width — not to hide that sessions exist,
   * which is the whole feature.
   */
  collapsed?: boolean;
  /** Omitted by the mobile drawer, which closes rather than collapses. */
  onToggleCollapsed?: () => void;
  className?: string;
};

const formatWhen = (iso: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

const initialOf = (title: string) => title.trim().charAt(0).toUpperCase() || "•";

const railButtonStyle =
  "rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground";

const NewSessionButton = ({ onCreate }: { onCreate: () => void }) => (
  <button
    type="button"
    onClick={onCreate}
    title="New session"
    aria-label="New session"
    className={railButtonStyle}
  >
    <MessageSquarePlus className="size-4" />
  </button>
);

/**
 * The collapse control sits on the rail itself. It started in the chat header,
 * where it was a plain icon several inches from the thing it moved — findable
 * only by someone already looking for it.
 */
const CollapseButton = ({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) => {
  const label = collapsed ? "Expand sessions" : "Collapse sessions";
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <button
      type="button"
      onClick={onToggle}
      title={label}
      aria-label={label}
      aria-expanded={!collapsed}
      className={railButtonStyle}
    >
      <Icon className="size-4" />
    </button>
  );
};

export const SessionSidebar = ({
  sessions,
  activeSessionId,
  onCreate,
  onSelect,
  onDelete,
  collapsed = false,
  onToggleCollapsed,
  className,
}: SessionSidebarProps) => {
  /**
   * The collapsed rail shows one character per session, so the full title has
   * to be reachable on hover. It is positioned against the viewport rather than
   * the button: the list scrolls, and `overflow-y: auto` clips on both axes, so
   * anything drawn inside it would be cut off at the rail's edge.
   */
  const [hoveredSession, setHoveredSession] = useState<{
    id: string;
    top: number;
    left: number;
  } | null>(null);

  if (collapsed) {
    const hovered = sessions.find((session) => session.id === hoveredSession?.id);

    return (
      <aside
        className={cn("flex flex-col items-center gap-1 bg-muted/30 py-2", className)}
      >
        {onToggleCollapsed ? (
          <CollapseButton collapsed onToggle={onToggleCollapsed} />
        ) : null}
        <NewSessionButton onCreate={onCreate} />
        <div className="flex w-full flex-1 flex-col items-center gap-1 overflow-y-auto pt-2">
          {sessions.map((session) => {
            const isActive = session.id === activeSessionId;
            return (
              <button
                key={session.id}
                type="button"
                aria-label={session.title}
                aria-current={isActive}
                onClick={() => onSelect(session.id)}
                onMouseEnter={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setHoveredSession({
                    id: session.id,
                    top: rect.top,
                    left: rect.right + 8,
                  });
                }}
                onMouseLeave={() => setHoveredSession(null)}
                onFocus={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setHoveredSession({
                    id: session.id,
                    top: rect.top,
                    left: rect.right + 8,
                  });
                }}
                onBlur={() => setHoveredSession(null)}
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-md text-xs font-medium",
                  isActive
                    ? "bg-accent text-accent-foreground ring-1 ring-border"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                {initialOf(session.title)}
              </button>
            );
          })}
        </div>

        {hovered && hoveredSession ? (
          <div
            role="tooltip"
            style={{ top: hoveredSession.top, left: hoveredSession.left }}
            className="pointer-events-none fixed z-50 w-56 rounded-md border border-border bg-popover px-3 py-2 text-popover-foreground shadow-md"
          >
            <p className="text-[13px] leading-snug">{hovered.title}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {formatWhen(hovered.updatedAt)}
            </p>
          </div>
        ) : null}
      </aside>
    );
  }

  return (
    <aside className={cn("flex flex-col bg-muted/30", className)}>
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Sessions
        </span>
        <div className="flex items-center gap-0.5">
          <NewSessionButton onCreate={onCreate} />
          {onToggleCollapsed ? (
            <CollapseButton collapsed={false} onToggle={onToggleCollapsed} />
          ) : null}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        <ul className="space-y-1">
          {sessions.map((session) => {
            const isActive = session.id === activeSessionId;
            return (
              <li key={session.id}>
                {/* Not a nested button: the delete control lives inside the row. */}
                <div
                  role="button"
                  tabIndex={0}
                  aria-current={isActive}
                  onClick={() => onSelect(session.id)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onSelect(session.id);
                  }}
                  className={cn(
                    "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-left text-sm",
                    isActive
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] leading-tight">{session.title}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {formatWhen(session.updatedAt)}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={`Delete ${session.title}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      // Deleting drops the transcript for good, and the row is a
                      // small target sitting next to the switch action.
                      if (!window.confirm(`Delete “${session.title}”?`)) return;
                      onDelete(session.id);
                    }}
                    className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-red-500 focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
};
