export function bindExternalSubtitlePicker({ engine, input, openButton, clearButton, status, }) {
    function setStatus(message) {
        if (status)
            status.textContent = message;
    }
    function reset() {
        input.value = '';
        setStatus('');
        if (clearButton)
            clearButton.disabled = true;
    }
    openButton.addEventListener('click', () => {
        input.click();
    });
    clearButton?.addEventListener('click', () => {
        engine.clearExternalSubtitles();
        reset();
    });
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        input.value = '';
        if (!file)
            return;
        try {
            setStatus(`Loading subtitles: ${file.name}`);
            await engine.loadExternalSubtitle(file);
            setStatus(`Subtitles: ${file.name}`);
            if (clearButton)
                clearButton.disabled = false;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setStatus(`Subtitle error: ${message}`);
            if (clearButton)
                clearButton.disabled = true;
        }
    });
    reset();
    return { reset };
}
//# sourceMappingURL=external-subtitle-picker.js.map