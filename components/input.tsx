import { ArrowUp } from "lucide-react";
import { Input as ShadcnInput } from "./ui/input";
import { cn } from "@/lib/utils";

interface InputProps {
  input: string;
  handleInputChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  isInitializing: boolean;
  isLoading: boolean;
  status: string;
  stop: () => void;
}

export const Input = ({
  input,
  handleInputChange,
  isInitializing,
  isLoading,
  status,
  stop,
}: InputProps) => {
  const isDisabled = isLoading || isInitializing;

  return (
    <div className="relative w-full">
      <ShadcnInput
        className={cn(
          "py-6 w-full rounded-xl pr-12 transition-colors",
          // Enabled is a clean white field you type into; disabled fills with
          // grey and dashes its edge. The shadcn default is `opacity-50`, a
          // barely dimmer version of the same box that says nothing about why,
          // so `disabled:opacity-100` turns it off — the placeholder is now
          // what explains the state, and it has to stay readable.
          isDisabled
            ? "bg-muted border-dashed border-border disabled:opacity-100"
            : "bg-background border-border",
        )}
        value={input}
        autoFocus
        placeholder={
          isInitializing
            ? "Starting the desktop…"
            : isLoading
              ? "The agent is working — stop it to type"
              : "Tell me what to do..."
        }
        onChange={handleInputChange}
        disabled={isDisabled}
      />
      {status === "streaming" || status === "submitted" ? (
        <button
          type="button"
          onClick={stop}
          className="cursor-pointer absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-2 bg-primary hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
        >
          <div className="animate-spin h-4 w-4">
            <svg className="h-4 w-4 text-primary-foreground" viewBox="0 0 24 24">
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
                fill="none"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
          </div>
        </button>
      ) : (
        <button
          type="submit"
          disabled={isLoading || !input.trim() || isInitializing}
          className="cursor-pointer absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-2 bg-primary hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
        >
          <ArrowUp className="h-4 w-4 text-primary-foreground" />
        </button>
      )}
    </div>
  );
};
