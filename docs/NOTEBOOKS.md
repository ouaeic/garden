# Project notebooks

Open a notebook from Project files to inspect its cells and recorded outputs. Choose **Edit
notebook** in a working directory to edit code, Markdown and raw cells, change their types, insert
or remove cells, and change their order. **Undo** and **Redo** include structural changes. Published
versions remain read-only.

Saving preserves notebook metadata, attachments and fields Garden does not interpret. Converting
a Markdown cell keeps its attachments in metadata until it is converted back. Changing code or
its order marks recorded outputs as stale. **Clear outputs** explicitly removes them and can be
undone. Saving an edit does not execute code or imply that the recorded outputs came from it.

Saves compare the file version read by the editor with the version still on disk. A concurrent edit
is refused without replacing the other writer's work. Your unsaved copy stays open and can be
downloaded before you discard it and reload. View navigation keeps an editor open while it holds
unsaved changes; refreshing or closing the browser invokes its unsaved-change protection.

The editor and preview bound the document they load and page the cells and outputs they render.
Those interface bounds do not impose a limit on project datasets, downloads or long-running
analysis. Unsupported notebook structures remain inspectable and downloadable. Rich recorded
output stays inert: opening a notebook does not run scripts or fetch its remote images.
