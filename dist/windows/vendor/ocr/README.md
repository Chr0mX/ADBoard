# OCR models for Windows (not committed)

Macro **text steps** (Tap text, Wait for text, If text, Read text) need two model files here:

- `text-detection.rten`
- `text-recognition.rten`

**Automated (preferred):** from the repo root:

```bash
make fetch-deps FETCH_TARGET=windows
# or on Windows PowerShell:
.\scripts\fetch-deps.ps1
```

**Manual:** download both files from `https://ocrs-models.s3-accelerate.amazonaws.com/` and copy them here, or put them anywhere and set `ADBOARD_OCR_MODELS` to that folder.

ADBoard finds this folder on its own (`vendor\ocr` next to `ADBoard.exe`). Touch macros work without the models. The models are from [ocrs-models](https://github.com/robertknight/ocrs-models) (Apache-2.0). Do **not** commit them.
