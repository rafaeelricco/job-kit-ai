---
name: captcha-solver
description: >
  Solve a CAPTCHA already on the attached browser-use page (reCAPTCHA,
  Turnstile, hCaptcha, image/text challenge). Use when: captcha, recaptcha,
  turnstile, hcaptcha, "i'm not a robot", "verify you are human", challenge.
  Not for general browsing or starting a session (use browser-use). Not for
  avoiding captchas up front — that stays browser-use cloud guidance.
---

# CAPTCHA solver

Requires an attached **browser-use** session. If `browser-use` is not loaded,
read its `SKILL.md` now and follow it for connection; do not restate that
skill here.

Send each Python step to browser-use through standard input. Use
`browser-use <<'PY' … PY` in Bash; in PowerShell use:

```powershell
@'
# Python step
'@ | browser-use
```

For screenshot steps, include `from pathlib import Path` and
`from tempfile import gettempdir` in that invocation.
Prefer helpers already on that
surface (`click_at_xy`, `js`, `wait`, `page_info`, `capture_screenshot`,
`fill_input`, `cdp`). When stuck on a mechanic (iframes, screenshots, drag),
open the matching file under browser-use’s Interaction Skills list.

**Split with browser-use:** not yet browsing / scraping where blocking is
likely → follow browser-use (cloud). Widget already on the user’s attached
tab and the user wants it solved → this skill.

## Checkbox (reCAPTCHA / Turnstile / hCaptcha)

1. Locate the widget iframe bounds with `js(...)` (vendor `src` substrings:
   `recaptcha`, `hcaptcha`, `challenges.cloudflare`). If AX already exposes
   the checkbox, use browser-use’s AX → box → `click_at_xy` path instead.
2. Click left-center of the iframe: `click_at_xy(bounds["x"] + 12, bounds["y"] + bounds["height"] / 2)`.
3. `wait(3)`.
4. Verify with `page_info()`, a short `js("document.body.innerText.slice(0, 500)")`,
   and/or `capture_screenshot(str(Path(gettempdir()) / "captcha.png"), max_dim=1800)`.

```python
from pathlib import Path
from tempfile import gettempdir

bounds = js("""(() => {
  const el = document.querySelector(
    'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare"]'
  );
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {x: r.x, y: r.y, width: r.width, height: r.height};
})()""")
if not bounds:
    raise SystemExit("no captcha iframe found")
click_at_xy(bounds["x"] + 12, bounds["y"] + bounds["height"] / 2)
wait(3)
print(page_info())
print(js("document.body.innerText.slice(0, 500)"))
print(capture_screenshot(str(Path(gettempdir()) / "captcha.png"), max_dim=1800))
```

## Slider / puzzle drag

No drag helper on browser-use. Drive a stepped press→move→release with raw
`cdp("Input.dispatchMouseEvent", …)` (CSS viewport px). `button` names the
event's button; `buttons` is the held-button bitmask and defaults to 0, so
every move between press and release needs `buttons=1` or a widget that reads
`MouseEvent.buttons` aborts the drag. If the widget ignores it, stop and open
browser-use’s `drag-and-drop` interaction skill — do not invent a second drag
API here.

```python
from pathlib import Path
from tempfile import gettempdir

def drag_xy(x0, y0, x1, y1, steps=20):
    cdp("Input.dispatchMouseEvent", type="mouseMoved", x=x0, y=y0)
    cdp("Input.dispatchMouseEvent", type="mousePressed", x=x0, y=y0, button="left", clickCount=1)
    for i in range(1, steps + 1):
        t = i / steps
        cdp("Input.dispatchMouseEvent", type="mouseMoved", x=x0 + (x1 - x0) * t, y=y0 + (y1 - y0) * t, button="left", buttons=1)
    cdp("Input.dispatchMouseEvent", type="mouseReleased", x=x1, y=y1, button="left", clickCount=1)

# from / to = handle and target centers (CSS px), from screenshot or js bounds
drag_xy(from_x, from_y, to_x, to_y, steps=40)
wait(2)
print(capture_screenshot(str(Path(gettempdir()) / "captcha-drag.png"), max_dim=1800))
```

## Text / number

1. `path = capture_screenshot(str(Path(gettempdir()) / "captcha-text.png"), max_dim=1800)`.
2. OCR with agent vision on that PNG (no harness `readText`).
3. Fill the answer field with `fill_input(selector, text)` (or focus + `type_text`).
4. Submit it — the form's own control, or Enter. Filling the field does not submit.
5. Verify as in Checkbox step 4.

Measure clicks from the image only after converting device px → CSS px; the
conversion rule lives in browser-use’s screenshots interaction skill.

## Image grid

1. Screenshot (`max_dim=1800`).
2. Vision picks which cells match the prompt.
3. Click each cell center with `click_at_xy` (CSS px).
4. Click the widget's own Verify / Next / Skip control. Selecting cells does
   not submit, and without it no response token is issued.
5. Verify with another screenshot / `js` / `page_info`, then return whether
   solved or another grid remains. Each invocation handles one grid round;
   the caller owns retries and their limit.

No annotated overlay helper exists — cell geometry is yours from the PNG and
widget bounds.

## Out of scope

- Starting Chrome, `--doctor`, `mac-approve`, `BU_NAME`, cloud spawn/auth.
- Restating browser-use page workflow (AX tree, `new_tab`, recordings).
- Claiming a `captcha` global or Aside REPL APIs.
