"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

const OPTIONS = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "system", label: "System", Icon: Monitor },
  { value: "dark", label: "Dark", Icon: Moon },
] as const;

/**
 * Three explicit choices rather than a two-way flip: "system" is a real state
 * here, and a flip cannot express it — once flipped, the app would stop
 * following the OS for the rest of the session with no way back.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  // `theme` is unknown until the client reads storage, so the first paint must
  // not commit to a selected segment or it hydrates against the wrong one.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div
      className="flex items-center gap-0.5 rounded-full border border-border bg-muted/50 p-0.5"
      role="radiogroup"
      aria-label="Color theme"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const isActive = mounted && theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={isActive}
            aria-label={label}
            title={label}
            onClick={() => setTheme(value)}
            className={cn(
              "cursor-pointer rounded-full p-1.5 text-muted-foreground transition-colors hover:text-foreground",
              isActive && "bg-background text-foreground shadow-xs",
            )}
          >
            <Icon className="size-3.5" />
          </button>
        );
      })}
    </div>
  );
}
