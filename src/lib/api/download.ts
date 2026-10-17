/** Save a Blob as a file. Used for downloads that need an auth header. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser time to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

type SavePicker = (options: {
  suggestedName: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<{ createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }> }>;

/**
 * Export a text file. Where the browser has a Save dialog (Chrome, Edge) it
 * opens with the suggested name, so the user picks the folder and Windows asks
 * before replacing a file; elsewhere it is a normal download, and the browser
 * adds " (1)" instead of overwriting. Resolves false when the user cancels.
 */
export async function saveTextFile(text: string, suggestedName: string, type = "application/json"): Promise<boolean> {
  const blob = new Blob([text], { type });
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (picker && window.self === window.top) {
    try {
      const plain = type === "text/plain";
      const handle = await picker({
        suggestedName,
        types: [{ description: plain ? "Text file" : "ADBoard file", accept: { [type]: [plain ? ".txt" : ".json"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (error) {
      if ((error as DOMException)?.name === "AbortError") return false;
      // No permission or an unsupported type: fall back to a download.
    }
  }
  saveBlob(blob, suggestedName);
  return true;
}
