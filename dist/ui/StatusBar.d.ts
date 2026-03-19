interface StatusBarProps {
    mode: "preview" | "diff";
    filePath: string | null;
}
export default function StatusBar({ mode, filePath }: StatusBarProps): import("react/jsx-runtime").JSX.Element;
export {};
