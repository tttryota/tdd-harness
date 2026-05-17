import type { CommandResult } from "../../domain/model/types.ts";
import type { LauncherOptions } from "../../infrastructure/process/launcher.ts";

export type ToolExecutor = {
  run(toolName: string, args: string[], options: LauncherOptions): Promise<CommandResult>;
};
