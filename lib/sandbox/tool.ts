import { tool } from "ai";
import { z } from "zod";
import { anthropicProvider } from "@/lib/ai/provider";
import { getDesktop } from "./utils";

const wait = async (seconds: number) => {
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
};

export const resolution = { x: 1024, y: 768 };

const DISPLAY_ENV = { DISPLAY: ":99" };

// Map key names to X11 keysym names used by xdotool
const keyMap: Record<string, string> = {
  Return: "Return",
  enter: "Return",
  tab: "Tab",
  space: "space",
  backspace: "BackSpace",
  delete: "Delete",
  escape: "Escape",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "Prior",
  pagedown: "Next",
  f1: "F1",
  f2: "F2",
  f3: "F3",
  f4: "F4",
  f5: "F5",
  f6: "F6",
  f7: "F7",
  f8: "F8",
  f9: "F9",
  f10: "F10",
  f11: "F11",
  f12: "F12",
  shift: "Shift_L",
  control: "Control_L",
  ctrl: "Control_L",
  alt: "Alt_L",
  super: "Super_L",
  meta: "Super_L",
};

function mapKey(key: string): string {
  // Handle modifier combos like "ctrl+c" — xdotool supports this natively
  if (key.includes("+")) {
    return key
      .split("+")
      .map((part) => keyMap[part.toLowerCase()] || part)
      .join("+");
  }
  return keyMap[key.toLowerCase()] || keyMap[key] || key;
}

/**
 * The arguments every computer action can carry. Deliberately a superset of the
 * fields Anthropic's `computer_20250124` tool sends, so the same executor backs
 * both the provider-defined tool and the schema-described fallback below.
 */
type ComputerInput = {
  action: string;
  coordinate?: number[];
  text?: string;
  duration?: number;
  scroll_amount?: number;
  scroll_direction?: string;
  start_coordinate?: number[];
};

type ComputerResultData =
  { type: "image"; data: string } | { type: "text"; text: string };

type ExecutionMeta = {
  startedAt: string;
  completedAt: string;
  durationMs: number;
};

type ComputerResult =
  | ({ ok: true; data: ComputerResultData } & ExecutionMeta)
  | ({ ok: false; error: string } & ExecutionMeta);

type BashResult =
  | ({ ok: true; stdout: string } & ExecutionMeta)
  | ({ ok: false; error: string; stdout?: string } & ExecutionMeta);

const withExecutionMeta = async <T,>(
  run: () => Promise<T>,
): Promise<({ ok: true; data: T } | { ok: false; error: string }) & ExecutionMeta> => {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  try {
    const data = await run();
    const completedAt = new Date().toISOString();
    return {
      ok: true,
      data,
      startedAt,
      completedAt,
      durationMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    const completedAt = new Date().toISOString();
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      startedAt,
      completedAt,
      durationMs: Math.round(performance.now() - started),
    };
  }
};

const runComputerAction =
  (sandboxId: string) =>
  async ({
    action,
    coordinate,
    text,
    duration,
    scroll_amount,
    scroll_direction,
    start_coordinate,
  }: ComputerInput): Promise<ComputerResultData> => {
    const sandbox = await getDesktop(sandboxId);

    switch (action) {
      case "screenshot": {
        await sandbox.runCommand({
          cmd: "import",
          args: ["-window", "root", "/tmp/screenshot.png"],
          env: DISPLAY_ENV,
        });
        const buffer = await sandbox.readFileToBuffer({
          path: "/tmp/screenshot.png",
        });
        if (!buffer) throw new Error("Failed to read screenshot");
        const base64Data = buffer.toString("base64");
        return {
          type: "image" as const,
          data: base64Data,
        };
      }
      case "wait": {
        if (!duration) throw new Error("Duration required for wait action");
        const actualDuration = Math.min(duration, 2);
        await wait(actualDuration);
        return {
          type: "text" as const,
          text: `Waited for ${actualDuration} seconds`,
        };
      }
      case "left_click": {
        if (!coordinate)
          throw new Error("Coordinate required for left click action");
        const [x, y] = coordinate;
        await sandbox.runCommand({
          cmd: "xdotool",
          args: ["mousemove", "--sync", String(x), String(y), "click", "1"],
          env: DISPLAY_ENV,
        });
        return { type: "text" as const, text: `Left clicked at ${x}, ${y}` };
      }
      case "double_click": {
        if (!coordinate)
          throw new Error("Coordinate required for double click action");
        const [x, y] = coordinate;
        await sandbox.runCommand({
          cmd: "xdotool",
          args: [
            "mousemove",
            "--sync",
            String(x),
            String(y),
            "click",
            "--repeat",
            "2",
            "1",
          ],
          env: DISPLAY_ENV,
        });
        return {
          type: "text" as const,
          text: `Double clicked at ${x}, ${y}`,
        };
      }
      case "right_click": {
        if (!coordinate)
          throw new Error("Coordinate required for right click action");
        const [x, y] = coordinate;
        await sandbox.runCommand({
          cmd: "xdotool",
          args: ["mousemove", "--sync", String(x), String(y), "click", "3"],
          env: DISPLAY_ENV,
        });
        return {
          type: "text" as const,
          text: `Right clicked at ${x}, ${y}`,
        };
      }
      case "mouse_move": {
        if (!coordinate)
          throw new Error("Coordinate required for mouse move action");
        const [x, y] = coordinate;
        await sandbox.runCommand({
          cmd: "xdotool",
          args: ["mousemove", "--sync", String(x), String(y)],
          env: DISPLAY_ENV,
        });
        return { type: "text" as const, text: `Moved mouse to ${x}, ${y}` };
      }
      case "type": {
        if (!text) throw new Error("Text required for type action");
        await sandbox.runCommand({
          cmd: "xdotool",
          args: ["type", "--clearmodifiers", text],
          env: DISPLAY_ENV,
        });
        return { type: "text" as const, text: `Typed: ${text}` };
      }
      case "key": {
        if (!text) throw new Error("Key required for key action");
        const mappedKey = mapKey(text);
        await sandbox.runCommand({
          cmd: "xdotool",
          args: ["key", mappedKey],
          env: DISPLAY_ENV,
        });
        return { type: "text" as const, text: `Pressed key: ${text}` };
      }
      case "scroll": {
        if (!scroll_direction)
          throw new Error("Scroll direction required for scroll action");
        if (!scroll_amount)
          throw new Error("Scroll amount required for scroll action");
        // Button 4 = scroll up, button 5 = scroll down
        const button = scroll_direction === "up" ? "4" : "5";
        await sandbox.runCommand({
          cmd: "xdotool",
          args: ["click", "--repeat", String(scroll_amount), button],
          env: DISPLAY_ENV,
        });
        return {
          type: "text" as const,
          text: `Scrolled ${scroll_direction} by ${scroll_amount}`,
        };
      }
      case "left_click_drag": {
        if (!start_coordinate || !coordinate)
          throw new Error("Coordinates required for drag action");
        const [startX, startY] = start_coordinate;
        const [endX, endY] = coordinate;
        await sandbox.runCommand({
          cmd: "xdotool",
          args: [
            "mousemove",
            String(startX),
            String(startY),
            "mousedown",
            "1",
            "mousemove",
            "--sync",
            String(endX),
            String(endY),
            "mouseup",
            "1",
          ],
          env: DISPLAY_ENV,
        });
        return {
          type: "text" as const,
          text: `Dragged mouse from ${startX}, ${startY} to ${endX}, ${endY}`,
        };
      }
      default:
        throw new Error(`Unsupported action: ${action}`);
    }
  };

const executeComputerAction =
  (sandboxId: string) =>
  async (input: ComputerInput): Promise<ComputerResult> =>
    withExecutionMeta(() => runComputerAction(sandboxId)(input));

/**
 * Only screenshot/text content is exposed to the model. Execution metadata stays
 * in the UI message result for the dashboard and must not be stringified into the
 * model-facing tool result content.
 */
function toToolResultContent(result: ComputerResult | string) {
  if (typeof result === "string") {
    return [{ type: "text" as const, text: result }];
  }
  if (!result.ok) {
    return [{ type: "text" as const, text: `Error: ${result.error}` }];
  }
  if (result.data.type === "image" && result.data.data) {
    return [
      {
        type: "image" as const,
        data: result.data.data,
        mimeType: "image/png",
      },
    ];
  }
  if (result.data.type === "text" && result.data.text) {
    return [{ type: "text" as const, text: result.data.text }];
  }
  throw new Error("Invalid result format");
}

function toBashToolResultContent(result: BashResult | string) {
  if (typeof result === "string") {
    return [{ type: "text" as const, text: result }];
  }
  return [
    {
      type: "text" as const,
      text: result.ok ? result.stdout : `Error: ${result.error}`,
    },
  ];
}

/**
 * `native` uses Anthropic's provider-defined computer/bash tools — the model was
 * trained on them, so they give the best accuracy. `schema` re-declares the same
 * tools as ordinary function tools with an explicit JSON schema.
 *
 * The fallback exists because Anthropic-compatible relays commonly strip
 * provider-defined tools: they carry no `input_schema`, so a proxy that
 * normalises the tool list drops the definition and the model emits `computer`
 * calls with an empty `{}` input. Describing the same surface as a normal
 * function tool survives that round-trip.
 */
export type ComputerToolMode = "native" | "schema";

export const computerToolMode: ComputerToolMode =
  process.env.COMPUTER_TOOL_MODE === "native" ? "native" : "schema";

const computerParameters = z.object({
  action: z
    .enum([
      "screenshot",
      "left_click",
      "double_click",
      "right_click",
      "mouse_move",
      "left_click_drag",
      "type",
      "key",
      "scroll",
      "wait",
    ])
    .describe("The action to perform on the virtual desktop."),
  coordinate: z
    .array(z.number().int())
    .length(2)
    .optional()
    .describe(
      "Target [x, y] in pixels. Required for left_click, double_click, " +
        "right_click, mouse_move and left_click_drag (as the drag end point).",
    ),
  start_coordinate: z
    .array(z.number().int())
    .length(2)
    .optional()
    .describe("Starting [x, y] of a left_click_drag."),
  text: z
    .string()
    .optional()
    .describe(
      "Text to type for `type`, or the key/chord for `key` " +
        '(e.g. "Return", "ctrl+l", "alt+Tab").',
    ),
  scroll_direction: z
    .enum(["up", "down", "left", "right"])
    .optional()
    .describe("Scroll direction. Required for `scroll`."),
  scroll_amount: z
    .number()
    .int()
    .optional()
    .describe("Number of scroll wheel clicks. Required for `scroll`."),
  duration: z
    .number()
    .optional()
    .describe("Seconds to wait for `wait`. Capped at 2 seconds."),
});

const COMPUTER_DESCRIPTION = [
  `Control a Linux desktop over X11. The screen is ${resolution.x}x${resolution.y} pixels;`,
  "coordinates are in pixels with the origin (0, 0) at the TOP-LEFT corner,",
  `x growing right up to ${resolution.x - 1} and y growing down to ${resolution.y - 1}.`,
  "",
  "Always call this tool with action=screenshot first, and again after any action",
  "that changes the screen, so you can read the current state before deciding where",
  "to click. Never guess coordinates from memory — locate the target in the most",
  "recent screenshot and aim at the centre of the element.",
  "",
  "Actions:",
  "- screenshot: capture the screen. Returns a PNG.",
  "- left_click / right_click / double_click: click at `coordinate`.",
  "- mouse_move: move the cursor to `coordinate` without clicking.",
  "- left_click_drag: press at `start_coordinate`, release at `coordinate`.",
  "- type: type `text` at the current focus. Click the target field first.",
  "- key: press the key or chord in `text`, e.g. Return, Tab, ctrl+l, alt+F4.",
  "- scroll: scroll `scroll_amount` clicks in `scroll_direction` under the cursor.",
  "- wait: pause `duration` seconds while the UI settles.",
].join("\n");

export const computerTool = (sandboxId: string) => {
  const execute = executeComputerAction(sandboxId);

  if (computerToolMode === "native") {
    return anthropicProvider.tools.computer_20250124({
      displayWidthPx: resolution.x,
      displayHeightPx: resolution.y,
      displayNumber: 1,
      execute,
      experimental_toToolResultContent: toToolResultContent,
    });
  }

  return tool({
    description: COMPUTER_DESCRIPTION,
    parameters: computerParameters,
    execute,
    experimental_toToolResultContent: toToolResultContent,
  });
};

const executeBash =
  (sandboxId?: string) =>
  async ({ command }: { command: string }): Promise<BashResult> => {
    const result = await withExecutionMeta(async () => {
      const sandbox = await getDesktop(sandboxId);
      const result = await sandbox.runCommand({
        cmd: "bash",
        args: ["-c", command],
        env: DISPLAY_ENV,
      });
      const stdout = await result.stdout();
      return stdout || "(Command executed successfully with no output)";
    });

    if (result.ok) {
      const { data, ...meta } = result;
      return { ...meta, stdout: data };
    }
    console.error("Bash command failed:", result.error);
    return result;
  };

export const bashTool = (sandboxId?: string) => {
  const execute = executeBash(sandboxId);

  if (computerToolMode === "native") {
    return anthropicProvider.tools.bash_20250124({ execute });
  }

  return tool({
    description:
      "Run a bash command inside the same Linux desktop sandbox and return its " +
      "stdout. Prefer this over the computer tool whenever the task can be done " +
      "from a shell (creating files, inspecting the filesystem, launching apps).",
    parameters: z.object({
      command: z.string().describe("The bash command to run."),
    }),
    execute,
    experimental_toToolResultContent: toBashToolResultContent,
  });
};
