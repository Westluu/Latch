import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { Box, Text, useFocus, useInput } from "ink";
const statusColors = {
    modified: "yellow",
    added: "green",
    deleted: "red",
    untracked: "gray",
};
const statusLabels = {
    modified: "M",
    added: "A",
    deleted: "D",
    untracked: "?",
};
export default function FileList({ files, selectedIndex, onSelect, onOpen }) {
    const { isFocused } = useFocus({ id: "file-list" });
    useInput((input, key) => {
        if (key.upArrow || input === "k") {
            onSelect(Math.max(0, selectedIndex - 1));
        }
        else if (key.downArrow || input === "j") {
            onSelect(Math.min(files.length - 1, selectedIndex + 1));
        }
        else if (key.return) {
            onOpen(selectedIndex);
        }
    }, { isActive: isFocused });
    return (_jsxs(Box, { flexDirection: "column", borderStyle: "single", borderColor: isFocused ? "blue" : "gray", paddingX: 1, children: [_jsx(Box, { marginBottom: 1, children: _jsxs(Text, { bold: true, color: isFocused ? "blue" : "white", children: ["Changed Files (", files.length, ")"] }) }), files.length === 0 ? (_jsx(Text, { dimColor: true, children: "No changed files" })) : (files.map((file, i) => {
                const isSelected = i === selectedIndex;
                const color = statusColors[file.status];
                return (_jsx(Box, { children: _jsxs(Text, { color: color, bold: isSelected, inverse: isSelected && isFocused, children: [statusLabels[file.status], " ", file.path] }) }, file.path));
            }))] }));
}
//# sourceMappingURL=FileList.js.map