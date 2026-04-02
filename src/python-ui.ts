import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function pythonUiScriptPath(scriptName: string): string {
  return join(__dirname, "..", "python", "ui", scriptName);
}

export function pythonUiCommand(scriptName: string, ...args: string[]): string {
  const quotedArgs = args.map((arg) => JSON.stringify(arg)).join(" ");
  const argsSuffix = quotedArgs ? ` ${quotedArgs}` : "";
  return `python3 "${pythonUiScriptPath(scriptName)}"${argsSuffix}`;
}
