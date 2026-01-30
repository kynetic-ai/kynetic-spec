import type { Command } from "commander";
import { ulid } from "ulid";
import { output } from "../output.js";

/**
 * Register utility commands
 * AC: @cli-utilities
 */
export function registerUtilCommands(program: Command): void {
  const util = program
    .command("util")
    .description("Utility commands for development tasks");

  // kspec util ulid - generate valid ULIDs
  // AC: @cli-utilities ac-1
  util
    .command("ulid")
    .description("Generate valid ULIDs for YAML fixtures")
    .option("-c, --count <n>", "Number of ULIDs to generate", "1")
    .action((options) => {
      const count = Math.max(1, parseInt(options.count, 10) || 1);
      const ulids: string[] = [];

      for (let i = 0; i < count; i++) {
        ulids.push(ulid());
      }

      output({ ulids }, () => {
        for (const id of ulids) {
          console.log(id);
        }
      });
    });
}
