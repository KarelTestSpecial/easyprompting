# Easy Prompting

A safe scratchpad for AI chat prompts. Draft in an open window, never lose a
prompt to a stray **Enter** or **Ctrl+C**, then copy it. Nothing is ever sent from this
window — Enter just makes a new line.

A Manifest V3 Chrome extension.

## Repository layout

| Path | What |
|---|---|
| `easyprompting/` | The unpacked extension (load this folder via `chrome://extensions` → *Load unpacked*) |
| `LEGAL/PRIVACY.md` | Privacy policy |
| `LEGAL/cws_permissions_justification.txt` | Permission justifications for the Chrome Web Store |
| `easyprompting-1.1.zip` | Packaged build, ready for the Chrome Web Store (extension folder only) |
| `promo/` | Store promo assets + `make_promo.py` generator |
| `STORE_LISTING.md` | Chrome Web Store listing copy |

## Features

- **Two shapes, one pad** — opens as a **browser tab by default** (drag it into
  any window, keep it beside your AI chat) or as a slim **floating window**
  without toolbars. Switch anytime with the `Float` / `Tab` button in the top
  bar, or right-click the toolbar icon. Only one copy ever runs: switching
  moves the same pad instead of duplicating it.
- **Enter never sends** — a calm window where nothing is transmitted.
- **Autosave** — every keystroke is stored locally.
- **Multiple tabs** — keep a system prompt, a draft and snippets side by side.
- **One-click copy**, live word/character counter, adjustable text size.
- **Keyboard tab navigation**: `Alt+E` / `Alt+R`, `Alt+1…9`, `Alt+←/→`, `Ctrl+[ / ]`.
- **100% local & private** — no accounts, no tracking, no network requests.

## Privacy

Everything is stored on your device via `chrome.storage`. See
[`LEGAL/PRIVACY.md`](LEGAL/PRIVACY.md).

## Related

Need a clock, alarms, a screensaver and a richer research notepad too? See the
companion extension **Very Practical Clock & Notepad**.

## License

MIT — see [`LEGAL/LICENSE`](LEGAL/LICENSE).
