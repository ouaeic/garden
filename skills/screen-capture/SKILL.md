---
name: screen-capture
description: Save what the browser or the desktop is showing as an image file in the workspace - a page for a report, a proof that a form was filled, the screen of a desktop application - and check the file before handing it over. Use whenever the user asks for a screenshot, a capture or a picture of a page or the screen saved to disk. Do not use to read a page or the screen for your own eyes, which browser_snapshot and desktop_observe already do without writing a file, and never search the filesystem for a browser binary to drive by hand.
license: AGPL-3.0-or-later
compatibility: The browser half needs the garden browser runner; the desktop half needs the GUI desktop, whose display owns ffmpeg and xdotool.
allowed-tools: browser_action print_pdf shell desktop_observe image_read
metadata:
  garden.tier: 'builtin'
  garden.version: '1.0.0'
  garden.risk: 'workspace'
  garden.domain: 'web'
---

# Screen capture

Two facts decide whether this takes one call or twenty-three. `browser_snapshot` and
`desktop_observe` return a picture to you and write nothing to disk. The one browser action that
writes a picture is `browser_action` with `action: screenshot`.

## A page, as the browser shows it

```
browser_action { action: "screenshot", path: "proofs/example.png" }
```

One call. It writes the current tab's viewport as a PNG at that workspace path, creating the folder,
and returns the path it wrote. Pass `tabId` for a tab that is not the active one; nothing is brought
to the front. Navigate first and wait for what you need to be on screen - a capture taken straight
after `navigate` on a single-page application is the empty shell.

The path is workspace-relative and both spellings are one file: `proofs/example.png` and
`workspace/proofs/example.png`. A path that steps outside the workspace is refused before anything
is captured.

For the whole document rather than the viewport, print it and render the pages:

```
print_pdf { path: "proofs/example.pdf" }
shell pdftoppm -png -r 100 proofs/example.pdf proofs/example
```

`pdftoppm` writes `proofs/example-1.png`, `proofs/example-2.png` and so on; add `-singlefile` for a
one-page document to get `proofs/example.png`. The shell already runs inside `workspace/`, so the
path is `proofs/example.pdf` there, not `workspace/proofs/example.pdf` - that spelling names a
directory that does not exist.

## The desktop screen

The agent's shell is not given `DISPLAY`. The desktop's X server is the one socket under
`/tmp/.X11-unix`, and its number is the display:

```
shell bash -lc 'ls /tmp/.X11-unix'          # X90  ->  the display is :90
```

Capture one frame with the same tool the desktop uses for its own stills, at the geometry
`desktop_observe` reports as `displayWidth` x `displayHeight`:

```
shell ffmpeg -hide_banner -loglevel error -nostdin -f x11grab -draw_mouse 1 -video_size 1280x800 -i :90 -frames:v 1 -y proofs/desktop.png
```

It exits non-zero and prints why when the display or the geometry is wrong; a wrong `-video_size`
is refused outright rather than cropped. Bring the application you want into view with
`desktop_action` first - the capture is of the whole screen, and a window behind another is not in
it.

## Check the file before you hand it over

`image_read` the file. A zero-byte PNG, a capture of the wrong tab and a screen with the wrong
window in front all exit zero; only looking catches them. Then `publish_artifact`, because a file
sitting in the workspace has not been handed over.

## What goes wrong

- **Looking for a browser to drive from the shell.** The session browser belongs to the runner and
  is reached only through the browser tools. `which chromium`, `find / -iname '*chrome*'` and a
  hand-launched headless browser cost a live task 23 of its 25 tool calls and produced nothing.
- **`workspace/` written into a command.** The file lands in `workspace/workspace/...`, `image_read`
  cannot find it, and the capture is lost. Write the path without the prefix.
- **Capturing before the page settled.** Use `browser_action` `wait_for` on a selector or text,
  then capture.
- **A desktop capture from a shell with no display.** `ffmpeg` reports that it cannot open the
  display. The display is the socket's number, passed with `-i :NN` as above.
