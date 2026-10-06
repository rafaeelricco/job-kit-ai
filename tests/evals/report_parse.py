"""Read the fixed anchors that references/report.md defines for a job-resume-review report."""
import re
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

SCORE = re.compile(r"Score:\s*(\d+)/100\s*·\s*coverage\s*(\d+)%\s*·\s*(final|provisional)(?:\s*·\s*capped from\s*(\d+))?")
CRITERIA = ("Criterion", "Rating", "Points", "Evidence")
BULLETS = ("Location", "Weight", "Rating", "Finding")
MATRIX = ("Requirement", "Weight", "Evidence", "Credit")
NUMBER = re.compile(r"\d+(?:\.\d+)?")


@dataclass
class Report:
    text: str
    score: Optional[int]
    coverage: Optional[int]
    provisional: Optional[bool]
    capped_from: Optional[int]
    criteria: Dict[str, float]  # lowercased criterion -> rating
    bullets: Dict[str, float]  # "E1.B3" -> rating
    matrix: Dict[str, float]  # lowercased requirement -> credit


def table(text: str, header: Tuple[str, ...]) -> List[List[str]]:
    """Body rows of the first markdown table whose header cells equal `header`; bold and code marks stripped."""
    rows: List[List[str]] = []
    inside = False
    for line in text.splitlines():
        if not line.lstrip().startswith("|"):
            if inside:
                break
            continue
        cells = [c.strip().replace("**", "").replace("`", "") for c in line.strip().strip("|").split("|")]
        if tuple(cells) == header:
            inside = True
        elif inside and not set("".join(cells)) <= set("-: "):
            rows.append(cells)
    return rows


def column(text: str, header: Tuple[str, ...], value: int, lower: bool) -> Dict[str, float]:
    found = {}
    for row in table(text, header):
        match = NUMBER.search(row[value]) if len(row) > value else None
        if match:
            found[row[0].lower() if lower else row[0]] = float(match.group())
    return found


def parse(text: str) -> Report:
    m = SCORE.search(text)
    return Report(
        text=text,
        score=int(m.group(1)) if m else None,
        coverage=int(m.group(2)) if m else None,
        provisional=m.group(3) == "provisional" if m else None,
        capped_from=int(m.group(4)) if m and m.group(4) else None,
        criteria=column(text, CRITERIA, 1, lower=True),
        bullets=column(text, BULLETS, 2, lower=False),
        matrix=column(text, MATRIX, 3, lower=True),
    )
