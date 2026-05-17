import type { ToolExecutor } from "../../application/ports/tool-executor.ts";
import { runTool } from "./launcher.ts";

export class LauncherToolExecutor implements ToolExecutor {
  async run(toolName: string, args: string[], options: import("./launcher.ts").LauncherOptions) {
    return runTool(toolName, args, options);
  }
}
