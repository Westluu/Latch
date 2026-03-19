import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { Box, useApp, useInput, useStdout } from "ink";
import FileList from "./FileList.js";
import Preview from "./Preview.js";
import StatusBar from "./StatusBar.js";
// Placeholder files for now — will be replaced by git integration in Step 4
const PLACEHOLDER_FILES = [
    { path: "src/cli.ts", status: "modified" },
    { path: "src/tmux.ts", status: "modified" },
    { path: "src/sidecar.ts", status: "added" },
    { path: "src/ui/App.tsx", status: "added" },
    { path: "src/ui/FileList.tsx", status: "added" },
    { path: "src/ui/Preview.tsx", status: "added" },
    { path: "package.json", status: "modified" },
];
const PLACEHOLDER_CONTENT = `// This is a placeholder preview.
// In Step 4, selecting a file will show its real contents.
// In Step 5, syntax highlighting will be added.

export function hello() {
  console.log("Hello from Latch!");
}
`;
export default function App({ cwd }) {
    const { exit } = useApp();
    const { stdout } = useStdout();
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [openedFile, setOpenedFile] = useState(null);
    const [scrollOffset, setScrollOffset] = useState(0);
    const [mode, setMode] = useState("preview");
    const termHeight = stdout?.rows ?? 24;
    // Reserve lines for status bar and borders
    const previewMaxLines = termHeight - 6;
    useInput((input) => {
        if (input === "q") {
            exit();
        }
    });
    const handleOpen = (index) => {
        setOpenedFile(PLACEHOLDER_FILES[index]?.path ?? null);
        setScrollOffset(0);
    };
    return (_jsxs(Box, { flexDirection: "column", height: termHeight, children: [_jsxs(Box, { flexGrow: 1, children: [_jsx(Box, { width: "40%", children: _jsx(FileList, { files: PLACEHOLDER_FILES, selectedIndex: selectedIndex, onSelect: setSelectedIndex, onOpen: handleOpen }) }), _jsx(Box, { flexGrow: 1, children: _jsx(Preview, { filePath: openedFile, content: PLACEHOLDER_CONTENT, scrollOffset: scrollOffset, onScroll: setScrollOffset, maxLines: previewMaxLines }) })] }), _jsx(StatusBar, { mode: mode, filePath: openedFile })] }));
}
//# sourceMappingURL=App.js.map