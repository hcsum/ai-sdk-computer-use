import {
  Camera,
  Clock,
  Keyboard,
  KeyRound,
  MousePointer,
  MousePointerClick,
  ScrollText,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import type { ToolEvent, TurnEvent } from "./agent-events";

/**
 * The one place a `ToolEvent` turns into words and an icon. The chat transcript
 * and the event panel show the same call at different densities, so they share
 * the projection and differ only in which of these they call.
 */

const truncate = (value: string, max = 120) =>
  value.length > max ? `${value.slice(0, max)}…` : value;

const formatCoordinate = (coordinate?: number[]) =>
  coordinate ? `(${coordinate[0]}, ${coordinate[1]})` : "";

type ComputerAction = {
  title: string;
  detail: (event: Extract<ToolEvent, { tool: "computer" }>) => string;
  icon: LucideIcon;
};

const COMPUTER_ACTIONS: Record<string, ComputerAction> = {
  screenshot: { title: "Taking screenshot", detail: () => "", icon: Camera },
  left_click: {
    title: "Left clicking",
    detail: (event) => (event.coordinate ? `at ${formatCoordinate(event.coordinate)}` : ""),
    icon: MousePointer,
  },
  right_click: {
    title: "Right clicking",
    detail: (event) => (event.coordinate ? `at ${formatCoordinate(event.coordinate)}` : ""),
    icon: MousePointerClick,
  },
  double_click: {
    title: "Double clicking",
    detail: (event) => (event.coordinate ? `at ${formatCoordinate(event.coordinate)}` : ""),
    icon: MousePointerClick,
  },
  mouse_move: {
    title: "Moving mouse",
    detail: (event) => (event.coordinate ? `to ${formatCoordinate(event.coordinate)}` : ""),
    icon: MousePointer,
  },
  type: {
    title: "Typing",
    detail: (event) => (event.text ? `"${event.text}"` : ""),
    icon: Keyboard,
  },
  key: {
    title: "Pressing key",
    detail: (event) => (event.text ? `"${event.text}"` : ""),
    icon: KeyRound,
  },
  wait: { title: "Waiting", detail: () => "", icon: Clock },
  scroll: { title: "Scrolling", detail: () => "", icon: ScrollText },
};

/**
 * The narrative form used inline in the transcript: "Left clicking at (397, 47)".
 */
export const describeToolAction = (
  event: ToolEvent,
): { title: string; detail: string; icon: LucideIcon } => {
  switch (event.tool) {
    case "computer": {
      const action = COMPUTER_ACTIONS[event.action];
      if (!action) {
        return { title: event.action, detail: "", icon: MousePointer };
      }
      return { title: action.title, detail: action.detail(event), icon: action.icon };
    }
    case "bash":
      return {
        title: "Running command",
        detail: truncate(event.command, 40),
        icon: Terminal,
      };
    default:
      return {
        title: event.toolName,
        detail: event.payload ? truncate(JSON.stringify(event.payload), 40) : "",
        icon: Wrench,
      };
  }
};

/**
 * The compact form used in the event panel, where the tool name is the heading
 * and the raw action is the subtitle.
 */
export const describeToolEvent = (event: ToolEvent): { label: string; detail: string } => {
  switch (event.tool) {
    case "computer": {
      const detail = event.coordinate
        ? ` (${event.coordinate.join(", ")})`
        : event.text
          ? ` ${event.text}`
          : "";
      return { label: "computer", detail: truncate(`${event.action}${detail}`) };
    }
    case "bash":
      return { label: "bash", detail: truncate(event.command) || "No command" };
    default:
      return {
        label: event.toolName,
        detail: event.payload ? truncate(JSON.stringify(event.payload)) : "No payload",
      };
  }
};

/**
 * A turn shows who spoke and nothing else — the words themselves live in the
 * transcript, which is the only place that owns them.
 */
export const describeTurnEvent = (event: TurnEvent) =>
  event.role === "user"
    ? { label: "You", detail: "user_turn" }
    : { label: "Agent", detail: "assistant_turn" };

export const formatDuration = (durationMs?: number) => {
  if (durationMs === undefined) return null;
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
};
