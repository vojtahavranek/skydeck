# What is new

The notes in this folder are what the window's update dialog shows when an update brings them (the
dialog of `Update available`; `skydeck update --check` lists their titles). One small file per
change a user can see.

## When to write one

A change a user can see adds a note: what they will see and how to use it, in plain words, without
internal names (no file, function or issue names, no plan steps). Tests and internal work add none.
A note is not changed or removed once it is merged: an update shows the notes that are new to it.

## The format

The file is `docs/news/<yyyy-mm-dd>-<name>.md`, the date it was written and a short name of
lower-case letters, digits and hyphens: `2026-11-25-parked.md`. Its first line is `# <title>`;
after a blank line, the text: a few plain sentences, in one or more paragraphs (a blank line
between them; a line break inside a paragraph is a space). A run between two backticks is code.
Nothing else of Markdown is interpreted: it is shown as written. For example:

```
# Parked: set a session aside

Press w on a session that waits for someone
else. It moves to its own section after Open,
keeps running, and comes back by itself when
you send it a prompt.
```

The title is at most 120 characters, the text at most 600 (all its paragraphs), the file at most
8 KiB, in UTF-8 without control characters. The suite's test (`test/news.test.ts`) fails on a
note that is not so, and on any other file here but this one. The dialog shows the newest notes
first, by file name.
