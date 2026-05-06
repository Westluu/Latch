export type TerminalBindingId = "primary" | "workspaces" | "chat";

export interface TerminalBindingDescriptor {
  id: TerminalBindingId;
  shortcut: string;
  label: string;
  escapeHex: string;
  escapeSequence: string;
  letter: string;
}

export const terminalBindingDescriptors: TerminalBindingDescriptor[] = [
  {
    id: "primary",
    shortcut: "CMD+E",
    label: "toggle",
    escapeHex: "\\x1be",
    escapeSequence: "\\033e",
    letter: "e",
  },
  {
    id: "workspaces",
    shortcut: "CMD+P",
    label: "workspaces",
    escapeHex: "\\x1bp",
    escapeSequence: "\\033p",
    letter: "p",
  },
  {
    id: "chat",
    shortcut: "CMD+S",
    label: "chat",
    escapeHex: "\\x1bs",
    escapeSequence: "\\033s",
    letter: "s",
  },
];

const bindingMap = new Map(terminalBindingDescriptors.map((binding) => [binding.id, binding]));

export function getTerminalBinding(bindingId: TerminalBindingId): TerminalBindingDescriptor {
  const binding = bindingMap.get(bindingId);
  if (!binding) {
    throw new Error(`Unknown terminal binding: ${bindingId}`);
  }
  return binding;
}

function splitLines(content: string): string[] {
  return content.replace(/\r\n/g, "\n").split("\n");
}

function finalizeConfig(lines: string[]): string {
  const trimmed = [...lines];
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === "") {
    trimmed.pop();
  }
  return trimmed.length === 0 ? "" : `${trimmed.join("\n")}\n`;
}

function appendBlock(content: string, lines: string[]): string {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\n+$/g, "");
  if (normalized.length === 0) {
    return `${lines.join("\n")}\n`;
  }
  return `${normalized}\n${lines.join("\n")}\n`;
}

export function configHasLine(content: string, line: string): boolean {
  return splitLines(content).includes(line);
}

export function removeManagedConfigBinding(content: string, marker: string, line: string): string {
  const input = splitLines(content);
  const output: string[] = [];

  for (let index = 0; index < input.length; index += 1) {
    if (input[index] === marker && input[index + 1] === line) {
      index += 1;
      continue;
    }
    output.push(input[index]);
  }

  return finalizeConfig(output);
}

export function removeManagedConfigBindings(
  content: string,
  bindings: Array<{ marker: string; line: string }>
): string {
  return bindings.reduce(
    (current, binding) => removeManagedConfigBinding(current, binding.marker, binding.line),
    content
  );
}

export function upsertManagedConfigBinding(content: string, marker: string, line: string): string {
  const cleaned = removeManagedConfigBinding(content, marker, line);
  if (configHasLine(cleaned, line)) {
    return cleaned;
  }
  return appendBlock(cleaned, [marker, line]);
}

export function upsertManagedConfigBindings(
  content: string,
  bindings: Array<{ marker: string; line: string }>
): string {
  return bindings.reduce(
    (current, binding) => upsertManagedConfigBinding(current, binding.marker, binding.line),
    content
  );
}

export function formatManualBindings(
  bindingIds: TerminalBindingId[],
  formatter: (binding: TerminalBindingDescriptor) => string
): string {
  return bindingIds.map((bindingId) => formatter(getTerminalBinding(bindingId))).join("; ");
}

export function formatBindingList(bindingIds: TerminalBindingId[]): string {
  return bindingIds.map((bindingId) => getTerminalBinding(bindingId).shortcut).join(", ");
}
