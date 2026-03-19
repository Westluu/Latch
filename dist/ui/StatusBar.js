import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { Box, Text } from "ink";
export default function StatusBar({ mode, filePath }) {
    return (_jsxs(Box, { children: [_jsxs(Text, { bold: true, inverse: true, color: "white", children: [" ", "LATCH", " "] }), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "Tab:focus  j/k:navigate  Enter:open  d:diff  o:editor  q:quit" })] }));
}
//# sourceMappingURL=StatusBar.js.map