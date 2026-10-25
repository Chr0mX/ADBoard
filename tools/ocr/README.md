# OCR models (not committed)

Macro **text steps** (Tap text, Wait for text, If text, Read text) read the phone's screen with [ocrs](https://github.com/robertknight/ocrs). It needs two model files here:

- `text-detection.rten`
- `text-recognition.rten`

Populated by:

```bash
make fetch-deps
# or only the models: FETCH_ONLY=ocr ./scripts/fetch-deps.sh
```

The script checks each file's SHA-256. To keep the models elsewhere, set `ADBOARD_OCR_MODELS` to their folder. Touch macros work without them.

The models are from [ocrs-models](https://github.com/robertknight/ocrs-models) (Apache-2.0). Do **not** commit them.
