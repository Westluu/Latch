interface PreviewProps {
    filePath: string | null;
    content: string;
    scrollOffset: number;
    onScroll: (offset: number) => void;
    maxLines: number;
}
export default function Preview({ filePath, content, scrollOffset, onScroll, maxLines }: PreviewProps): import("react/jsx-runtime").JSX.Element;
export {};
