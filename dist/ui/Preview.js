import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text, useFocus, useInput } from "ink";
export default function Preview({ filePath, content, scrollOffset, onScroll, maxLines }) {
    const { isFocused } = useFocus({ id: "preview" });
    const lines = content.split("\n");
    const totalLines = lines.length;
    const visibleLines = lines.slice(scrollOffset, scrollOffset + maxLines);
    useInput((input, key) => {
        if (key.upArrow || input === "k") {
            onScroll(Math.max(0, scrollOffset - 1));
        }
        else if (key.downArrow || input === "j") {
            onScroll(Math.min(Math.max(0, totalLines - maxLines), scrollOffset + 1));
        }
        else if (key.pageDown) {
            onScroll(Math.min(Math.max(0, totalLines - maxLines), scrollOffset + maxLines));
        }
        else if (key.pageUp) {
            onScroll(Math.max(0, scrollOffset - maxLines));
        }
    }, { isActive: isFocused });
    return (_jsxs(Box, { flexDirection: "column", borderStyle: "single", borderColor: isFocused ? "blue" : "gray", paddingX: 1, flexGrow: 1, children: [_jsxs(Box, { marginBottom: 1, children: [_jsx(Text, { bold: true, color: isFocused ? "blue" : "white", children: filePath ? `Preview: ${filePath}` : "Preview" }), filePath && totalLines > maxLines && (_jsxs(Text, { dimColor: true, children: [" ", "[", scrollOffset + 1, "-", Math.min(scrollOffset + maxLines, totalLines), "/", totalLines, "]"] }))] }), !filePath ? (_jsx(Text, { dimColor: true, children: "Select a file to preview" })) : (visibleLines.map((line, i) => {
                const lineNum = scrollOffset + i + 1;
                return (_jsxs(Box, { children: [_jsxs(Text, { dimColor: true, children: [String(lineNum).padStart(4), " "] }), _jsx(Text, { children: line })] }, `${lineNum}-${i}`));
            }))] }));
}
//# sourceMappingURL=Preview.js.map