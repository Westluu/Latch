export interface FileEntry {
    path: string;
    status: "modified" | "added" | "deleted" | "untracked";
}
interface FileListProps {
    files: FileEntry[];
    selectedIndex: number;
    onSelect: (index: number) => void;
    onOpen: (index: number) => void;
}
export default function FileList({ files, selectedIndex, onSelect, onOpen }: FileListProps): import("react/jsx-runtime").JSX.Element;
export {};
