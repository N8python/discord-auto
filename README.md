# Discord LM Studio Auto Translate

Minimal Chrome extension that translates visible Discord text with an LM Studio OpenAI-compatible server. Translations replace the visible Discord text in place and successful results are cached across reloads by default.

## Load it

1. Start LM Studio's local server at `http://127.0.0.1:1234`.
2. Load `google/gemma-4-26b-a4b` (Or any OpenAI-compatible model) in LM Studio. Note that the app has been tested with `gemma-4-26b-a4b` and may require prompt adjustments for other models.
3. Open Chrome Extensions: `chrome://extensions`.
4. Enable Developer mode.
5. Click Load unpacked and choose this folder.
6. Open Discord, click the extension, and set the source and target languages.

The default source language is `Spanish`, target language is `English`, concurrency is `4`, and the request body includes `"reasoning_effort": "none"`.

The popup saves settings automatically. The Enabled checkbox turns translation display and request handling on or off. If source and target are the same language, the extension pauses itself and restores originals until the languages differ again.

Successful translations are stored in Chrome local extension storage under a persistent cache capped at about 1 GiB.

Visible Discord text is translated from the configured source language to the target language.

Outgoing messages are translated at Discord's message-request layer. Press `Enter` normally and the extension pauses the outgoing message request, translates your draft from the target language into the configured source language, patches the request body, and caches the reverse mapping so your sent message renders back in your target language. If translation fails, the original send is allowed through.

It also installs a small page-context bridge that patches Discord's outgoing message request before it is sent.

If Discord was already open before the extension was loaded, opening the popup on that Discord tab will inject the extension scripts.

## License

CC0 1.0 Universal. See `LICENSE`.
