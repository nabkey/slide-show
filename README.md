# Offline Photo & Video Slideshow

A self-contained, **fully offline** slideshow for photos and videos — built for a
party where there's no internet. Drop your media in a folder, run one command, and
project it. Photos are ordered by the date they were taken; iPhone Live Photos and
standalone videos can play inline; and everything is tweakable from an on-screen
settings panel without touching the files.

It runs as a tiny local web server (Bun + SQLite, zero npm dependencies) so it can
do the things a plain HTML file can't: convert HEIC photos, read EXIF dates,
transcode videos, and remember your edits — all on your machine, nothing uploaded
anywhere.

## What it does

- **Chronological order** by EXIF "date taken" (with sensible fallbacks for files
  that have no metadata — including Android/Pixel `VID_20190601_114716`-style
  filenames).
- **HEIC support** — Apple HEIC photos are auto-converted to JPEG copies; your
  originals are never modified.
- **Live Photos & videos** — a paired `IMG_1234.HEIC` + `IMG_1234.MP4` becomes one
  slide you can show as a still or as the looping clip. Standalone videos become
  their own slides with a pickable poster frame.
- **On-screen controls** — slide duration, transitions (Fade / Slide / Drift /
  Cut), and a caption mode that can show the **date** or the subject's **age**.
- **Per-slide overrides** — change one photo's date, hide it, pick which still
  frame a video uses, trim a clip, set playback speed (½× / 1× / 2× / **Fit to
  slide**), or choose photo-vs-video for that slide only.
- **Library view** (press **L**) — a thumbnail grid of everything, with filters
  (Photos / Live / Videos / Uploads / Hidden), an edit modal per item, a hide
  toggle, and a play button to start the show from any item.
- **Uploads** — add photos and videos from the settings panel; HEIC is converted
  and non-web-friendly video is transcoded to H.264 MP4 automatically. (Originals
  go into `uploads/`.)
- **Edits are non-destructive** — every override lives in a local SQLite database
  (`slideshow.db`), so your actual photo files are left untouched.

## Requirements

macOS, with three tools (all free):

- **[Bun](https://bun.sh)** — the runtime. Install: `curl -fsSL https://bun.sh/install | bash`
- **exiftool** — reads photo/video dates. Install: `brew install exiftool`
- **ffmpeg** — video poster frames + transcoding. Install: `brew install ffmpeg`

`sips` (HEIC → JPEG, thumbnails) ships with macOS, so there's nothing to install
for that.

```sh
# one-liner for the Homebrew bits
brew install exiftool ffmpeg
```

## Quick start

1. Put your photos and videos in this folder (next to `index.html`).
2. Start it:
   - **Easiest:** double-click **`Start Slideshow.command`** in Finder. It launches
     the server and opens your browser.
   - **From a terminal:**
     ```sh
     bun server.ts          # then open http://127.0.0.1:8765
     bun server.ts --open   # ...or have it open the browser for you
     ```
3. Press **F** for fullscreen and let it run. The controls (the gear and the
   control bar) fade out whenever the mouse holds still — move it to bring them
   back. This works the same in a window or in fullscreen.

The first launch is the slow one — it converts every HEIC and reads every date.
After that it's cached, so restarts are instant.

## Keyboard & mouse

| Key / action            | Does                                            |
|-------------------------|-------------------------------------------------|
| **→ / ←**               | Next / previous slide                           |
| **Space**               | Pause / resume                                   |
| **F**                   | Toggle fullscreen                                |
| **L**                   | Open / close the Library                         |
| **Esc**                 | Close Library or edit modal; exit fullscreen     |
| Click left / right edge | Previous / next slide                            |
| Settings gear (top-right) | Open the settings panel                        |

## How your files are organized

| Path                     | What it is                                            |
|--------------------------|------------------------------------------------------|
| `index.html`, `server.ts`| The app (these are the only things that get committed)|
| `Start Slideshow.command`| Double-click launcher                                |
| *your photos & videos*   | Sit directly in this folder                           |
| `uploads/`               | Media added via the in-app uploader                   |
| `_converted/`            | Auto-generated JPEGs, posters, and thumbnails (cache) |
| `slideshow.db`           | Your per-slide edits + EXIF date cache                |

> **Keeping your edits:** if you move the slideshow to another folder or computer,
> copy `slideshow.db` along with your photos to preserve dates, trims, hidden
> items, etc. It's safe to delete `_converted/` anytime — it regenerates.

## Settings

Everything lives behind the **gear icon** (top-right), in four tabs. All of it is
stored in `slideshow.db` (not in the code), so it travels with your show and
there's nothing personal hardcoded:

- **Show** — the during-show controls: photos vs. videos, slide duration,
  transitions, caption style, and the library/upload buttons.
- **Slide** — per-photo overrides for whatever is on screen right now (date,
  trim, speed, poster frame, hide).
- **Look** — **Birthday** (the reference date for the **Age** caption; leave it
  empty if you aren't using age captions) and **Appearance** (accent, background,
  and caption colors plus the caption font). Changes apply live. Fonts are drawn
  from those installed on the machine, so it stays fully offline.
- **Hidden** — photos you've hidden, with a tap to bring them back.

The most-used controls are also on the **control bar** at the bottom of the
screen (previous / play-pause / next, seconds per slide, and fullscreen); both
it and the gear fade out when the mouse holds still.

## Notes

- It only listens on `127.0.0.1` (your machine) — nothing is exposed to the network.
- No internet is used at any point. Safe for an offline venue.
- Nothing personal is baked into the source — the birthday and look are all settings,
  so this repo is safe to share or make public.
