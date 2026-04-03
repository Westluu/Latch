from __future__ import annotations


APP_BG = "#080C16"
SURFACE_BG = "#0F1624"
PANEL_BG = "#080C16"
MODAL_BG = "#080C16"
OVERLAY_BG = "rgba(3, 7, 18, 0.72)"

BORDER = "#4B5563"
BORDER_FOCUS = "#3B82F6"
BORDER_SUBTLE = "#334155"

ACCENT = "#3B82F6"
ACCENT_SOFT = "#60A5FA"
ACCENT_PALE = "#93C5FD"
SELECTION_BG = "#374151"
ROW_SELECTION_BG = "#161B22"

TEXT_BRIGHT = "#F9FAFB"
TEXT_HIGH = "#F8FAFC"
TEXT_PRIMARY = "#E5E7EB"
TEXT_SECONDARY = "#CBD5E1"
TEXT_MUTED = "#94A3B8"
TEXT_SOFT = "#9CA3AF"
TEXT_SUBTLE = "#6B7280"
TEXT_FAINT = "#4B5563"
TEXT_ICON = "#475569"
TEXT_BUTTON = "#E2E8F0"
TEXT_ERROR_SOFT = "#FCA5A5"

SUCCESS = "#10B981"
ERROR = "#EF4444"
WARNING = "#F59E0B"
INFO = "#93C5FD"
INFO_STRONG = "#3B82F6"
THINKING = "#60A5FA"
INLINE_CODE = "#F97316"

BUTTON_BG = "#243041"
BUTTON_BG_PRIMARY = "#334155"
BUTTON_BORDER_PRIMARY = "#64748B"

DIFF_ADD_BG = "#0D2818"
DIFF_REMOVE_BG = "#2D1A1A"
CODE_BLOCK_FG = "#D1D5DB"

MODEL_BADGE_COLORS = {
    "opus": (THINKING, "#1E3A5F"),
    "sonnet": ("#86EFAC", "#14532D"),
    "haiku": (INFO, "#1E3A5F"),
}

MODEL_BADGE_FALLBACK = (INFO, "#1E3A5F")


def hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    value = hex_color.lstrip("#")
    if len(value) != 6:
        raise ValueError(f"Expected 6-digit hex color, got {hex_color!r}")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


def ansi_fg(hex_color: str) -> str:
    red, green, blue = hex_to_rgb(hex_color)
    return f"\033[38;2;{red};{green};{blue}m"
